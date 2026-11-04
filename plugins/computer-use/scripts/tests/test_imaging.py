"""The hand-written PNG encoder: decoded with Pillow where available, and
validated byte for byte regardless."""

import os
import struct
import time
import zlib

from .helpers import Suite

from cu.imaging import encode_png, encode_png_rgb, png_size

try:
    from PIL import Image
except ImportError:  # pragma: no cover - Pillow is only a test-time luxury
    Image = None

TMP = "/tmp/cu-imaging-test.png"


def decode(data, path=TMP):
    with open(path, "wb") as handle:
        handle.write(data)
    with Image.open(path) as image:
        return image.convert("RGB").copy()


def frame(rows, alpha=255):
    """Build a BGRA buffer from a list of RGB rows."""
    buffer = bytearray()
    for row in rows:
        for red, green, blue in row:
            buffer += bytes((blue, green, red, alpha))
    return bytes(buffer)


def run():
    suite = Suite("imaging")
    os.makedirs("/tmp", exist_ok=True)
    red, green, blue = (255, 0, 0), (0, 255, 0), (0, 0, 255)
    if not Image:
        suite.check("Pillow is available for pixel checks", False, "install Pillow to run the pixel assertions")

    # --- pixel fidelity ---------------------------------------------------
    rows = [[red, green], [blue, red]]
    data = encode_png(2, 2, frame(rows), 2 * 4, bottom_up=False)
    suite.equal("png_size reports 2x2", png_size(data), (2, 2))
    if Image:
        image = decode(data)
        suite.equal("top-down row order", [image.getpixel((0, 0)), image.getpixel((1, 0))], [red, green])
        suite.equal("second row", [image.getpixel((0, 1)), image.getpixel((1, 1))], [blue, red])
        suite.equal("the output is truecolour", image.mode, "RGB")

    flipped = encode_png(2, 2, frame(rows), 2 * 4, bottom_up=True)
    if Image:
        suite.equal("bottom-up input is flipped", decode(flipped).getpixel((0, 0)), blue)

    # --- stride handling --------------------------------------------------
    padded = bytearray()
    for row in rows:  # [red, green] then [blue, red], each with padding
        padded += frame([row])
        padded += bytes((7, 7, 7, 7))  # one extra pixel of padding
    data = encode_png(2, 2, bytes(padded), 2 * 4 + 4, bottom_up=False)
    if Image:
        image = decode(data)
        suite.equal("stride padding is skipped", image.getpixel((0, 0)), red)
        suite.equal("stride padding does not shift the next row", image.getpixel((0, 1)), blue)
        suite.equal("padding is never rendered", image.getpixel((1, 1)), red)

    # --- downsampling -----------------------------------------------------
    wide = [[red, green, blue, red, green]]
    data = encode_png(5, 1, frame(wide), 5 * 4, bottom_up=False, step=2)
    suite.equal("step=2 halves a 5px row", png_size(data), (3, 1))
    if Image:
        image = decode(data)
        suite.equal("downsampling keeps pixels 0, 2 and 4",
                    [image.getpixel((x, 0)) for x in range(3)], [red, blue, green])

    tall = [[red], [green], [blue]]
    suite.equal("step=2 halves a 3px column",
                png_size(encode_png(1, 3, frame(tall), 4, bottom_up=False, step=2)), (1, 2))
    if Image:
        image = decode(encode_png(1, 3, frame(tall), 4, bottom_up=False, step=2))
        suite.equal("vertical downsampling keeps rows 0 and 2",
                    [image.getpixel((0, y)) for y in range(2)], [red, blue])

    for width, limit in ((1920, 1920), (1920, 1280), (3000, 1280), (1000, 1280), (3840, 1920)):
        step = max(1, -(-width // limit))
        suite.check("the step for %d/%d stays within the limit" % (width, limit),
                    -(-width // step) <= limit, "%d > %d" % (-(-width // step), limit))

    # --- degenerate input -------------------------------------------------
    data = encode_png(1, 1, frame([[green]]), 4, bottom_up=False)
    suite.equal("1x1 encodes", png_size(data), (1, 1))
    if Image:
        suite.equal("1x1 pixel is correct", decode(data).getpixel((0, 0)), green)
    suite.equal("odd dimensions round trip",
                png_size(encode_png(3, 7, frame([[red] * 3] * 7), 12, bottom_up=False)), (3, 7))
    suite.raises("a short framebuffer is rejected", ValueError,
                 encode_png, 4, 4, b"\x00" * 32, 16, False)
    suite.raises("an empty framebuffer is rejected", ValueError, encode_png, 0, 0, b"", 0, False)

    # --- rgb encoder ------------------------------------------------------
    data = encode_png_rgb(2, 1, [bytes((10, 20, 30, 40, 50, 60))])
    suite.equal("rgb encoder size", png_size(data), (2, 1))
    if Image:
        image = decode(data)
        suite.equal("rgb encoder keeps channel order",
                    [image.getpixel((0, 0)), image.getpixel((1, 0))], [(10, 20, 30), (40, 50, 60)])

    # --- file structure ---------------------------------------------------
    data = encode_png(4, 4, frame([[red] * 4] * 4), 16, bottom_up=False)
    suite.check("png signature", data[:8] == b"\x89PNG\r\n\x1a\n")
    offset, tags, crc_ok = 8, [], True
    while offset < len(data):
        length = struct.unpack(">I", data[offset:offset + 4])[0]
        tag = data[offset + 4:offset + 8]
        body = data[offset + 8:offset + 8 + length]
        stored = struct.unpack(">I", data[offset + 8 + length:offset + 12 + length])[0]
        if zlib.crc32(tag + body) & 0xFFFFFFFF != stored:
            crc_ok = False
        tags.append(tag)
        offset += 12 + length
    suite.equal("chunk order", tags, [b"IHDR", b"IDAT", b"IEND"])
    suite.check("every chunk CRC is valid", crc_ok)
    width, height, depth, colour = struct.unpack(">IIBB", data[16:26])
    suite.equal("IHDR width", width, 4)
    suite.equal("IHDR bit depth", depth, 8)
    suite.equal("IHDR colour type is truecolour", colour, 2)
    suite.equal("the file ends exactly at IEND", offset, len(data))
    suite.equal("a truncated buffer reports no size", png_size(b"\x89PNG\r\n\x1a\n"), (0, 0))

    # --- real-sized frame -------------------------------------------------
    big = bytearray(1920 * 1080 * 4)
    for index in range(0, len(big), 4):
        big[index] = index % 251
        big[index + 3] = 255
    started = time.time()
    data = encode_png(1920, 1080, bytes(big), 1920 * 4, bottom_up=False)
    elapsed = time.time() - started
    suite.check("1920x1080 encodes in under 6s (%.2fs)" % elapsed, elapsed < 6.0, "%.2fs" % elapsed)
    suite.check("a full-screen png is a sane size", 20000 < len(data) < 12_000_000, len(data))
    if Image:
        suite.equal("full-screen decode matches the requested size", decode(data).size, (1920, 1080))

    return suite.finish()
