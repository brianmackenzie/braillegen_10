// BrailleGen engine.
//
// One source file, two emscripten build targets (see build.sh):
//   engine/core.wasm  (BRAILLEGEN_CORE_ONLY) — liblouis translation only.
//     Small, loads at startup, powers the live preview and the SVG/BRF/text
//     exports via translateBraille().
//   engine/stl.wasm   (full) — translation plus OpenCASCADE geometry.
//     Large, lazy-loaded on the first STL request; adds generateBrailleSTL().
//
// Pipeline: UTF-8 text -> UTF-16 -> lou_translateString -> Unicode braille
// (U+2800-28FF) -> word wrap -> JSON (core) or plate-and-dot geometry (full).
// Both exports share translateAndWrap(), so the preview, the 2D exports and
// the STL always agree on the braille.
//
// Translation tables are not embedded in the binaries. The JS side fetches
// each table's include-closure (listed in engine/tables-manifest.json) and
// writes it into the module's MEMFS under /tables before calling in, so
// tables can be updated without recompiling and the wasm stays small.

#include <emscripten.h>
#include <vector>
#include <string>
#include <iostream>
#include <sstream>
#include <cstdlib>
#include <algorithm>
#include <regex>
#include <set>
#include <ctime>
#include <iomanip>
#include <cstdint>

#include "liblouis.h"

#ifndef BRAILLEGEN_CORE_ONLY
// OpenCASCADE
#include <gp_Trsf.hxx>
#include <gp_Ax1.hxx>
#include <gp_Dir.hxx>
#include <BRepPrimAPI_MakeBox.hxx>
#include <BRepPrimAPI_MakeRevol.hxx>
#include <BRepAlgoAPI_Fuse.hxx>
#include <BRepAlgoAPI_Cut.hxx>
#include <BRepBuilderAPI_Transform.hxx>
#include <BRepBuilderAPI_MakeEdge.hxx>
#include <BRepBuilderAPI_MakeWire.hxx>
#include <BRepBuilderAPI_MakeFace.hxx>
#include <BRepMesh_IncrementalMesh.hxx>
#include <BRep_Tool.hxx>
#include <BRep_Builder.hxx>
#include <TopoDS_Compound.hxx>
#include <Poly_Triangulation.hxx>
#include <TopExp_Explorer.hxx>
#include <TopoDS.hxx>
#include <TopoDS_Face.hxx>
#include <TopoDS_Shape.hxx>
#include <TopoDS_Wire.hxx>
#include <StlAPI_Writer.hxx>
#include <Standard_Version.hxx>
#include <fstream>
#include <utility>
#endif

// ---------------------------------------------------------------------------
// UTF-8 <-> UTF-16 (liblouis widechar is unsigned short: UTF-16 code units)
// ---------------------------------------------------------------------------

static std::vector<widechar> utf8ToWide(const std::string& s) {
    std::vector<widechar> out;
    out.reserve(s.size());
    size_t i = 0;
    while (i < s.size()) {
        unsigned char c = (unsigned char)s[i];
        uint32_t cp = 0;
        int len = 0;
        if (c < 0x80)                { cp = c;        len = 1; }
        else if ((c & 0xE0) == 0xC0) { cp = c & 0x1F; len = 2; }
        else if ((c & 0xF0) == 0xE0) { cp = c & 0x0F; len = 3; }
        else if ((c & 0xF8) == 0xF0) { cp = c & 0x07; len = 4; }
        else { i++; continue; }              // invalid lead byte: skip
        if (i + len > s.size()) break;       // truncated tail: stop
        bool ok = true;
        for (int k = 1; k < len; k++) {
            unsigned char cc = (unsigned char)s[i + k];
            if ((cc & 0xC0) != 0x80) { ok = false; break; }
            cp = (cp << 6) | (cc & 0x3F);
        }
        if (!ok) { i++; continue; }
        i += len;
        // Reject overlong encodings and out-of-range codepoints (replace with
        // U+FFFD so malformed embedder input can never fabricate surrogates).
        static const uint32_t min_cp[5] = { 0, 0, 0x80, 0x800, 0x10000 };
        if (cp > 0x10FFFF || cp < min_cp[len]) cp = 0xFFFD;
        if (cp >= 0xD800 && cp <= 0xDFFF) continue;   // stray surrogate: drop
        if (cp <= 0xFFFF) {
            out.push_back((widechar)cp);
        } else {                                       // astral -> surrogate pair
            cp -= 0x10000;
            out.push_back((widechar)(0xD800 | (cp >> 10)));
            out.push_back((widechar)(0xDC00 | (cp & 0x3FF)));
        }
    }
    return out;
}

static void appendUtf8(std::string& out, uint32_t cp) {
    if (cp <= 0x7F) {
        out += (char)cp;
    } else if (cp <= 0x7FF) {
        out += (char)(0xC0 | (cp >> 6));
        out += (char)(0x80 | (cp & 0x3F));
    } else if (cp <= 0xFFFF) {
        out += (char)(0xE0 | (cp >> 12));
        out += (char)(0x80 | ((cp >> 6) & 0x3F));
        out += (char)(0x80 | (cp & 0x3F));
    } else {
        out += (char)(0xF0 | (cp >> 18));
        out += (char)(0x80 | ((cp >> 12) & 0x3F));
        out += (char)(0x80 | ((cp >> 6) & 0x3F));
        out += (char)(0x80 | (cp & 0x3F));
    }
}

static std::string wideToUtf8(const std::vector<widechar>& w) {
    std::string out;
    for (size_t i = 0; i < w.size(); ++i) {
        uint32_t cp = w[i];
        if (cp >= 0xD800 && cp <= 0xDBFF && i + 1 < w.size()
            && w[i + 1] >= 0xDC00 && w[i + 1] <= 0xDFFF) {
            cp = 0x10000 + ((cp - 0xD800) << 10) + (w[i + 1] - 0xDC00);
            ++i;
        }
        appendUtf8(out, cp);
    }
    return out;
}

// ---------------------------------------------------------------------------
// Shared translation + wrap pipeline
// ---------------------------------------------------------------------------

static void louLogCallbackImpl(logLevels level, const char* message) {
    std::cerr << "liblouis: " << message << std::endl;
}

static std::vector<std::string> splitTextAtNewline(const std::string& str) {
    std::vector<std::string> result;
    size_t start = 0;
    size_t end = str.find('\n');
    while (end != std::string::npos) {
        std::string s = str.substr(start, end - start);
        s.erase(s.find_last_not_of(" \n\r\t") + 1);
        result.push_back(s);
        start = end + 1;
        end = str.find('\n', start);
    }
    if (start <= str.size()) {
        std::string s = str.substr(start);
        s.erase(s.find_last_not_of(" \n\r\t") + 1);
        result.push_back(s);
    }
    return result;
}

// Translate `input` (UTF-8, may contain newlines) with `table`, wrap to
// maxChars cells per line (maxChars <= 0 disables wrapping).
// Returns false only on liblouis failure (bad/missing table).
static bool translateAndWrap(const std::string& input, const std::string& table,
                             int maxChars,
                             std::vector<std::vector<widechar>>& wrapped) {
    lou_registerLogCallback(louLogCallbackImpl);
    setenv("LOUIS_TABLEPATH", "/tables", 1);

    std::string tables_str = "braille-patterns.cti," + table;

    std::vector<std::vector<widechar>> translated;
    for (const auto& line : splitTextAtNewline(input)) {
        if (line.empty()) {
            translated.push_back({});
            continue;
        }
        std::vector<widechar> inbuf = utf8ToWide(line);
        if (inbuf.empty()) {
            translated.push_back({});
            continue;
        }
        // lou_translateString returns success even when the output buffer was
        // too small — the only signal is that it consumed fewer input chars
        // than provided. Escape sequences for undefined characters can expand
        // one input char to 7+ cells, so grow and retry until all input is
        // consumed.
        std::vector<widechar> outbuf(std::max<size_t>(256, inbuf.size() * 4 + 100));
        bool done = false;
        for (int attempt = 0; attempt < 5 && !done; ++attempt) {
            int inlen = (int)inbuf.size();
            int outlen = (int)outbuf.size();
            int success = lou_translateString(tables_str.c_str(), inbuf.data(), &inlen,
                                              outbuf.data(), &outlen,
                                              nullptr, nullptr, 0);
            if (!success) return false;
            if (inlen == (int)inbuf.size()) {
                outbuf.resize(outlen);
                done = true;
            } else {
                outbuf.assign(outbuf.size() * 4, 0);
            }
        }
        if (!done) return false;   // pathological expansion; report as failure
        translated.push_back(outbuf);
    }

    wrapped.clear();
    for (const auto& braille_line : translated) {
        if (braille_line.empty()) {
            wrapped.push_back({});
            continue;
        }
        if (maxChars <= 0) {
            wrapped.push_back(braille_line);
            continue;
        }

        // Preserve leading blank cells: braille uses leading cells meaningfully
        // (poetry, headings, nested lists), and the word-split below would
        // otherwise silently drop them.
        size_t lead = 0;
        while (lead < braille_line.size() && braille_line[lead] == 0x2800) lead++;
        size_t indent = std::min(lead, (size_t)std::max(0, maxChars - 1));

        // Split the remainder into words on the blank braille cell.
        std::vector<std::vector<widechar>> words;
        std::vector<widechar> current_word;
        for (size_t ci = lead; ci < braille_line.size(); ++ci) {
            widechar c = braille_line[ci];
            if (c == 0x2800) {
                words.push_back(current_word);
                current_word.clear();
            } else {
                current_word.push_back(c);
            }
        }
        words.push_back(current_word);

        // Hard-break any word longer than the line limit so the requested
        // width is always honored.
        std::vector<std::vector<widechar>> sized_words;
        for (auto& word : words) {
            if ((int)word.size() <= maxChars) {
                sized_words.push_back(word);
            } else {
                for (size_t off = 0; off < word.size(); off += maxChars) {
                    size_t n = std::min((size_t)maxChars, word.size() - off);
                    sized_words.emplace_back(word.begin() + off, word.begin() + off + n);
                }
            }
        }

        std::vector<widechar> current_line(indent, (widechar)0x2800);
        bool line_has_word = false;   // the indent alone must not trigger a separator
        for (const auto& word : sized_words) {
            // Indent + a near-full-width first word may not fit: shrink the
            // indent rather than exceed the requested line width (words are
            // already hard-broken to <= maxChars).
            if (!line_has_word && (int)(current_line.size() + word.size()) > maxChars) {
                current_line.assign((size_t)maxChars - word.size(), (widechar)0x2800);
            }
            size_t sep = line_has_word ? 1 : 0;
            size_t required = current_line.size() + sep + word.size();
            if ((int)required > maxChars && line_has_word) {
                wrapped.push_back(current_line);
                current_line.clear();
            } else if (line_has_word) {
                current_line.push_back(0x2800);
            }
            current_line.insert(current_line.end(), word.begin(), word.end());
            line_has_word = true;
        }
        if (!current_line.empty()) wrapped.push_back(current_line);
    }

    // Trim trailing empty lines (a lone trailing newline in the input should
    // not add an empty braille row to the output).
    while (!wrapped.empty() && wrapped.back().empty()) wrapped.pop_back();

    return true;
}

// Unicode braille codepoint -> dot bitmask (bit 0..7 = dot 1..8).
static inline uint8_t brailleDots(widechar codepoint) {
    if (codepoint >= 0x2800 && codepoint <= 0x28FF) {
        return (uint8_t)(codepoint - 0x2800);
    }
    return 0;
}

static bool anyEightDot(const std::vector<std::vector<widechar>>& lines) {
    for (const auto& line : lines)
        for (widechar c : line)
            if (brailleDots(c) & 0xC0) return true;
    return false;
}

static void appendJsonEscaped(std::string& out, const std::string& utf8) {
    for (unsigned char c : utf8) {
        switch (c) {
            case '"':  out += "\\\""; break;
            case '\\': out += "\\\\"; break;
            case '\b': out += "\\b";  break;
            case '\f': out += "\\f";  break;
            case '\n': out += "\\n";  break;
            case '\r': out += "\\r";  break;
            case '\t': out += "\\t";  break;
            default:
                if (c < 0x20) {
                    char buf[8];
                    snprintf(buf, sizeof(buf), "\\u%04x", c);
                    out += buf;
                } else {
                    out += (char)c;   // raw UTF-8 continuation/lead bytes pass through
                }
        }
    }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

extern "C" {

// Translate text and return JSON (UTF-8, static buffer, valid until next call):
//   {"ok":true,"eightDot":false,"lines":["<braille>","<braille>",...]}
//   {"ok":false,"error":"<message>"}
// maxCharsPerLine <= 0 disables wrapping.
EMSCRIPTEN_KEEPALIVE
const char* translateBraille(const char* raw_text, int max_chars_per_line,
                             const char* braille_table) {
    static std::string json;
    json.clear();

    std::vector<std::vector<widechar>> wrapped;
    if (!translateAndWrap(raw_text ? raw_text : "", braille_table ? braille_table : "",
                          max_chars_per_line, wrapped)) {
        json = "{\"ok\":false,\"error\":\"";
        appendJsonEscaped(json, std::string("liblouis failed to load or apply table: ")
                                 + (braille_table ? braille_table : "(null)"));
        json += "\"}";
        return json.c_str();
    }

    json = "{\"ok\":true,\"eightDot\":";
    json += anyEightDot(wrapped) ? "true" : "false";
    json += ",\"lines\":[";
    for (size_t i = 0; i < wrapped.size(); ++i) {
        if (i) json += ',';
        json += '"';
        appendJsonEscaped(json, wideToUtf8(wrapped[i]));
        json += '"';
    }
    json += "]}";
    return json.c_str();
}

} // extern "C"

#ifndef BRAILLEGEN_CORE_ONLY

// ---------------------------------------------------------------------------
// STL generation (full build only)
// ---------------------------------------------------------------------------

// Revolved dot profile: flat base -> shoulder -> rounded top.
// Shoulder/top-round are clamped so the profile stays valid for small dots.
static TopoDS_Shape createExactBrailleDot(double radius, double braille_height) {
    double shoulder = std::min(0.3, braille_height * 0.5);
    double top_r    = std::min(0.4, radius * 0.5);

    gp_Pnt p1(0.0, 0.0, 0.0);
    gp_Pnt p2(radius, 0.0, 0.0);
    gp_Pnt p3(radius, 0.0, braille_height - shoulder);
    gp_Pnt p4(top_r, 0.0, braille_height);
    gp_Pnt p5(0.0, 0.0, braille_height);

    TopoDS_Edge e1 = BRepBuilderAPI_MakeEdge(p1, p2);
    TopoDS_Edge e2 = BRepBuilderAPI_MakeEdge(p2, p3);
    TopoDS_Edge e3 = BRepBuilderAPI_MakeEdge(p3, p4);
    TopoDS_Edge e4 = BRepBuilderAPI_MakeEdge(p4, p5);
    TopoDS_Edge e5 = BRepBuilderAPI_MakeEdge(p5, p1);

    BRepBuilderAPI_MakeWire wire_maker;
    wire_maker.Add(e1); wire_maker.Add(e2); wire_maker.Add(e3);
    wire_maker.Add(e4); wire_maker.Add(e5);

    TopoDS_Face profile_face = BRepBuilderAPI_MakeFace(wire_maker.Wire());
    gp_Ax1 rev_axis(p1, gp_Dir(gp_Vec(p1, p5)));
    return BRepPrimAPI_MakeRevol(profile_face, rev_axis).Shape();
}

static void ExportShapeToSTL(const TopoDS_Shape& shape, const std::string& filename) {
    std::cout << "Meshing shape..." << std::endl;
    BRepMesh_IncrementalMesh mesh(shape, 0.08, false, 0.2);

    uint32_t total_triangles = 0;
    TopExp_Explorer ex(shape, TopAbs_FACE);
    for (; ex.More(); ex.Next()) {
        TopoDS_Face face = TopoDS::Face(ex.Current());
        TopLoc_Location loc;
        Handle(Poly_Triangulation) tri = BRep_Tool::Triangulation(face, loc);
        if (!tri.IsNull()) total_triangles += tri->NbTriangles();
    }

    std::ofstream out(filename, std::ios::out | std::ios::binary);

    char header[80] = {0};
    std::string header_text = "Binary STL generated by BrailleGen";
    std::copy_n(header_text.begin(), std::min(header_text.size(), (size_t)79), header);
    out.write(header, 80);
    out.write(reinterpret_cast<const char*>(&total_triangles), sizeof(total_triangles));

    ex.Init(shape, TopAbs_FACE);
    for (; ex.More(); ex.Next()) {
        TopoDS_Face face = TopoDS::Face(ex.Current());
        TopLoc_Location loc;
        Handle(Poly_Triangulation) tri = BRep_Tool::Triangulation(face, loc);
        if (tri.IsNull()) continue;
        for (int i = 1; i <= tri->NbTriangles(); ++i) {
            int n1, n2, n3;
            tri->Triangle(i).Get(n1, n2, n3);
            if (face.Orientation() == TopAbs_REVERSED) std::swap(n1, n2);

            gp_Pnt p1 = tri->Node(n1).Transformed(loc);
            gp_Pnt p2 = tri->Node(n2).Transformed(loc);
            gp_Pnt p3 = tri->Node(n3).Transformed(loc);

            gp_Vec u(p1, p2), v(p1, p3);
            gp_Vec norm = u.Crossed(v);
            if (norm.SquareMagnitude() > 0) norm.Normalize();
            else norm = gp_Vec(0, 0, 1);

            auto writeFloat = [&out](double val) {
                float f = static_cast<float>(val);
                out.write(reinterpret_cast<const char*>(&f), sizeof(f));
            };
            writeFloat(norm.X()); writeFloat(norm.Y()); writeFloat(norm.Z());
            writeFloat(p1.X()); writeFloat(p1.Y()); writeFloat(p1.Z());
            writeFloat(p2.X()); writeFloat(p2.Y()); writeFloat(p2.Z());
            writeFloat(p3.X()); writeFloat(p3.Y()); writeFloat(p3.Z());

            uint16_t attr = 0;
            out.write(reinterpret_cast<const char*>(&attr), sizeof(attr));
        }
    }
    out.close();
    std::cout << "File written to " << filename << std::endl;
}

static std::string sanitize_filename(const std::string& filename) {
    std::regex illegal_chars("[^a-zA-Z0-9]");
    std::string sanitized = std::regex_replace(filename, illegal_chars, "_");

    size_t endpos = sanitized.find_last_not_of(" .");
    if (std::string::npos != endpos) {
        sanitized = sanitized.substr(0, endpos + 1);
    } else {
        sanitized = "";
    }

    std::set<std::string> reserved_names = {
        "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4",
        "COM5", "COM6", "COM7", "COM8", "COM9", "LPT1", "LPT2", "LPT3",
        "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9"
    };
    std::string upper_sanitized = sanitized;
    for (char& c : upper_sanitized) c = std::toupper(static_cast<unsigned char>(c));
    if (reserved_names.count(upper_sanitized)) sanitized += "_";
    if (sanitized.empty()) sanitized = "braille";

    return sanitized;
}

extern "C" {

// Generate a 3D-printable braille STL. Returns the MEMFS filename ("" on error).
// Geometry parameters (all mm):
//   braille_height  dot height above the plate
//   plate_height    base plate thickness (0 = dots only)
//   line_spacing    extra gap between braille line strips
//   margin_size     border around the text area
//   dot_diameter    dot base diameter (defaults to 1.6 when <= 0)
//   dot_pitch       dot-to-dot distance within a cell (default 2.34)
//   cell_pitch      cell-to-cell distance (default 6.2)
EMSCRIPTEN_KEEPALIVE
const char* generateBrailleSTL(const char* raw_text, int max_chars_per_line,
                               const char* braille_table,
                               double braille_height, double plate_height,
                               double line_spacing, double margin_size,
                               double stl_scale, bool slab_mode, bool vertical_export,
                               double dot_diameter, double dot_pitch, double cell_pitch) {
    std::cout << "Starting text translation & STL generation..." << std::endl;

    // Defensive clamps (JS validates too; these are the last line of defense).
    if (dot_diameter <= 0.0) dot_diameter = 1.6;
    if (dot_pitch <= 0.0)    dot_pitch = 2.34;
    if (cell_pitch <= 0.0)   cell_pitch = 6.2;
    braille_height = std::max(0.35, braille_height);
    plate_height   = std::max(0.0, plate_height);
    line_spacing   = std::max(0.0, line_spacing);
    margin_size    = std::max(0.0, margin_size);
    if (stl_scale <= 0.0) stl_scale = 1.0;

    std::string input_text(raw_text ? raw_text : "");

    std::vector<std::vector<widechar>> wrapped_lines;
    if (!translateAndWrap(input_text, braille_table ? braille_table : "",
                          max_chars_per_line, wrapped_lines)) {
        std::cerr << "Translation failed (table: "
                  << (braille_table ? braille_table : "(null)") << ")." << std::endl;
        return "";
    }

    if (wrapped_lines.empty()) {
        std::cerr << "No braille text generated (empty input)." << std::endl;
        return "";
    }

    std::cout << "Wrapped Braille Output:" << std::endl;
    for (size_t i = 0; i < wrapped_lines.size(); ++i) {
        std::cout << "Line " << i + 1 << " (" << wrapped_lines[i].size() << " chars): "
                  << wideToUtf8(wrapped_lines[i]) << std::endl;
    }

    // Dot matrices: cell[col 0..1][row 0..3]
    //   dots 1-3 = col 0 rows 0-2, dots 4-6 = col 1 rows 0-2,
    //   dot 7 = col 0 row 3, dot 8 = col 1 row 3 (8-dot braille).
    bool eight_dot = anyEightDot(wrapped_lines);
    int rows_per_cell = eight_dot ? 4 : 3;
    if (eight_dot) std::cout << "8-dot braille detected: using 2x4 cells." << std::endl;

    std::vector<std::vector<uint8_t>> the_matrix;   // [line][char] -> dot mask
    size_t longest_length = 0;
    for (const auto& wline : wrapped_lines) {
        std::vector<uint8_t> mapped_line;
        for (widechar c : wline) mapped_line.push_back(brailleDots(c));
        if (mapped_line.size() > longest_length) longest_length = mapped_line.size();
        the_matrix.push_back(mapped_line);
    }

    if (longest_length == 0) {
        std::cerr << "No valid braille characters generated." << std::endl;
        return "";
    }

    double diameter = dot_diameter;
    double radius = diameter / 2.0;
    double spacing = dot_pitch;
    double distance = cell_pitch;

    double plate_depth = spacing * (rows_per_cell - 1) + diameter + line_spacing;
    double total_plate_depth = plate_depth * the_matrix.size() - line_spacing;

    auto calc_plate_length = [&](size_t len) {
        return std::max(0.1, (distance * len) + margin_size * 2.0 - (distance - spacing - diameter));
    };
    double max_plate_length = calc_plate_length(longest_length);

    // Base plate
    TopoDS_Shape plate;
    if (plate_height > 0.0) {
        if (slab_mode) {
            double slab_width = margin_size + total_plate_depth + margin_size;
            plate = BRepPrimAPI_MakeBox(gp_Pnt(-margin_size, 0, 0),
                                        gp_Pnt(slab_width - margin_size, max_plate_length, plate_height)).Shape();

            // Orientation corner cut
            double cut_depth = std::min(margin_size, 2.0) * 1.2;
            TopoDS_Shape corner_cutter = BRepPrimAPI_MakeBox(5.0, 5.0, plate_height + 2.0).Shape();
            gp_Trsf cut_trsf, trans_trsf;
            cut_trsf.SetRotation(gp_Ax1(gp_Pnt(0, 0, 0), gp_Dir(0, 0, 1)), 45.0 * (M_PI / 180.0));
            trans_trsf.SetTranslation(gp_Vec(-margin_size, max_plate_length - cut_depth, -1.0));
            trans_trsf.Multiply(cut_trsf);
            BRepBuilderAPI_Transform xform_cutter(corner_cutter, trans_trsf);
            plate = BRepAlgoAPI_Cut(plate, xform_cutter.Shape()).Shape();
        } else {
            bool first = true;
            TopoDS_Shape plate_shape;

            double top_plate_length = calc_plate_length(the_matrix[0].size());
            double bottom_plate_length = calc_plate_length(the_matrix.back().size());

            if (margin_size > 0.0) {
                TopoDS_Shape top_margin = BRepPrimAPI_MakeBox(gp_Pnt(-margin_size, 0, 0),
                                                              gp_Pnt(0, top_plate_length, plate_height)).Shape();
                plate_shape = top_margin;
                first = false;
            }

            for (size_t line = 0; line < the_matrix.size(); ++line) {
                double plate_length = calc_plate_length(the_matrix[line].size());
                double actual_depth = (line == the_matrix.size() - 1) ? (plate_depth - line_spacing) : plate_depth;
                if (actual_depth > 0.0 && plate_length > 0.0) {
                    TopoDS_Shape line_box = BRepPrimAPI_MakeBox(
                        gp_Pnt(plate_depth * line, 0, 0),
                        gp_Pnt(plate_depth * line + actual_depth, plate_length, plate_height)).Shape();
                    if (first) { plate_shape = line_box; first = false; }
                    else       { plate_shape = BRepAlgoAPI_Fuse(plate_shape, line_box).Shape(); }
                }
            }

            if (margin_size > 0.0) {
                TopoDS_Shape bottom_margin = BRepPrimAPI_MakeBox(
                    gp_Pnt(total_plate_depth, 0, 0),
                    gp_Pnt(total_plate_depth + margin_size, bottom_plate_length, plate_height)).Shape();
                if (first) plate_shape = bottom_margin;
                else       plate_shape = BRepAlgoAPI_Fuse(plate_shape, bottom_margin).Shape();
            }

            plate = plate_shape;
        }
    }

    // Dots
    TopoDS_Compound all_dots;
    BRep_Builder compound_builder;
    compound_builder.MakeCompound(all_dots);
    bool has_dots = false;

    double embed_depth = (plate_height > 0.0) ? 0.01 : 0.0;
    TopoDS_Shape base_dot = createExactBrailleDot(radius, braille_height + embed_depth);

    for (size_t line = 0; line < the_matrix.size(); ++line) {
        for (size_t char_index = 0; char_index < the_matrix[line].size(); ++char_index) {
            uint8_t mask = the_matrix[line][char_index];
            for (int col = 0; col < 2; ++col) {
                for (int row = 0; row < rows_per_cell; ++row) {
                    // bit for (col,row): rows 0-2 -> dots 1-6, row 3 -> dots 7/8
                    int bit = (row < 3) ? (col * 3 + row) : (6 + col);
                    if (!(mask & (1u << bit))) continue;

                    double x_pos = (plate_depth * line) + (spacing * row + radius);
                    double y_pos = (distance * char_index) + margin_size + (spacing * col + radius);
                    double z_pos = plate_height - embed_depth;

                    gp_Trsf dot_trsf;
                    dot_trsf.SetTranslation(gp_Vec(x_pos, y_pos, z_pos));
                    BRepBuilderAPI_Transform positioned_dot(base_dot, dot_trsf);
                    compound_builder.Add(all_dots, positioned_dot.Shape());
                    has_dots = true;
                }
            }
        }
    }

    // Fuse
    TopoDS_Shape export_shape;
    if (plate_height > 0.0 && has_dots) {
        std::cout << "Fusing geometry..." << std::endl;
        export_shape = BRepAlgoAPI_Fuse(plate, all_dots).Shape();
    } else if (plate_height > 0.0) {
        std::cout << "No valid dots generated. Outputting blank plate." << std::endl;
        export_shape = plate;
    } else if (has_dots) {
        std::cout << "No plate generated. Outputting dots only." << std::endl;
        export_shape = all_dots;
    } else {
        std::cout << "No valid dots generated and no plate. Outputting empty model." << std::endl;
        TopoDS_Compound empty_model;
        BRep_Builder().MakeCompound(empty_model);
        export_shape = empty_model;
    }

    // Orientation + scale
    gp_Trsf rot_z, rot_x, scale_trsf;
    rot_z.SetRotation(gp_Ax1(gp_Pnt(0, 0, 0), gp_Dir(0, 0, 1)), -90.0 * (M_PI / 180.0));
    rot_x.SetRotation(gp_Ax1(gp_Pnt(0, 0, 0), gp_Dir(1, 0, 0)), (vertical_export ? 90.0 : 0.0) * (M_PI / 180.0));
    scale_trsf.SetScale(gp_Pnt(0, 0, 0), stl_scale);

    gp_Trsf final_trsf = scale_trsf;
    final_trsf.Multiply(rot_x);
    final_trsf.Multiply(rot_z);

    BRepBuilderAPI_Transform apply_final(export_shape, final_trsf);
    export_shape = apply_final.Shape();

    std::time_t t = std::time(nullptr);
    std::tm tm = *std::localtime(&t);
    std::ostringstream oss;
    oss << std::put_time(&tm, "%H-%M-%S");

    std::vector<std::string> lines = splitTextAtNewline(input_text);
    std::string base_name = lines.empty() ? "braille" : lines[0];

    static std::string file_name;
    file_name = sanitize_filename(base_name) + "_" + oss.str() + ".stl";
    ExportShapeToSTL(export_shape, file_name);

    return file_name.c_str();
}

} // extern "C"

#endif // !BRAILLEGEN_CORE_ONLY

int main() {
#ifdef BRAILLEGEN_CORE_ONLY
    std::cout << "BrailleGen core (translator) loaded. liblouis " << lou_version() << std::endl;
#else
    std::cout << "BrailleGen WASM Core loaded." << std::endl;
    std::cout << "Liblouis version: " << lou_version() << std::endl;
    std::cout << "OpenCASCADE version: " << OCC_VERSION_STRING << std::endl;
#endif
    return 0;
}
