"""PNG encoding without third-party imaging libraries.

Screenshots are the only binary payload the server produces, so a small
encoder is cheaper than an imaging dependency.
"""

import struct
import zlib


def _chunk(tag, data):
    return (
        struct.pack(">I", len(data))
        + tag
        + data
        + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
    )


def _assemble(width, height, raw):
    header = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
    return (
        b"\x89PNG\r\n\x1a\n"
        + _chunk(b"IHDR", header)
        + _chunk(b"IDAT", zlib.compress(raw, 6))
        + _chunk(b"IEND", b"")
    )


def encode_png(width, height, bgra, stride=None, bottom_up=True, step=1):
    """Encode a BGRA framebuffer (as produced by the Win32 GDI blit) to PNG.

    ``step`` performs nearest-neighbour downsampling by keeping every n-th
    pixel, which stops very large displays from producing multi-megabyte
    payloads.
    """
    if stride is None:
        stride = width * 4
    if width <= 0 or height <= 0:
        raise ValueError("empty framebuffer: %dx%d" % (width, height))
    needed = (height - 1) * stride + width * 4
    if len(bgra) < needed:
        raise ValueError(
            "framebuffer too small: got %d bytes, need %d for %dx%d at stride %d"
            % (len(bgra), needed, width, height, stride)
        )
    step = max(1, int(step))
    out_w = (width + step - 1) // step
    out_h = (height + step - 1) // step
    raw = bytearray()
    for y in range(0, height, step):
        src_y = (height - 1 - y) if bottom_up else y
        line = bgra[src_y * stride : src_y * stride + width * 4]
        if step > 1:
            # Keep whole BGRA groups of every n-th pixel. Slicing the raw
            # bytes instead would tear the channels apart.
            line = b"".join(line[i:i + 4] for i in range(0, len(line), 4 * step))
        rgb = bytearray(len(line) // 4 * 3)
        rgb[0::3] = line[2::4]
        rgb[1::3] = line[1::4]
        rgb[2::3] = line[0::4]
        raw.append(0)
        raw += rgb
    return _assemble(out_w, out_h, bytes(raw))


def encode_png_rgb(width, height, rows):
    """Encode a sequence of RGB byte rows (top-down) to PNG."""
    raw = bytearray()
    for row in rows:
        raw.append(0)
        raw += row
    return _assemble(width, height, bytes(raw))


def png_size(data):
    """Read (width, height) from a PNG byte string."""
    if len(data) < 24 or data[:8] != b"\x89PNG\r\n\x1a\n":
        return (0, 0)
    return struct.unpack(">II", data[16:24])
