// Renders the DataStrap home-screen icons (pulse mark on black) as PNGs.
// Run: swift make_icons.swift  (writes src/icons/)
import AppKit

func render(size: Int, markFraction: CGFloat, to file: String) {
    let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: size, pixelsHigh: size, bitsPerSample: 8,
                               samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB,
                               bytesPerRow: 0, bitsPerPixel: 0)!
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
    let s = CGFloat(size)
    NSColor(srgbRed: 5 / 255, green: 5 / 255, blue: 6 / 255, alpha: 1).setFill()
    NSRect(x: 0, y: 0, width: s, height: s).fill()
    // The mark spans x 3...21 and y 6...18 of a 24-unit box (M3 12h4l2.5-6 4 12 2.5-6H21).
    let scale = s * markFraction / 18
    let ox = (s - 18 * scale) / 2 - 3 * scale
    let oy = (s - 12 * scale) / 2 - 6 * scale
    func p(_ x: CGFloat, _ y: CGFloat) -> NSPoint { NSPoint(x: ox + x * scale, y: s - (oy + y * scale)) }
    let path = NSBezierPath()
    path.move(to: p(3, 12)); path.line(to: p(7, 12)); path.line(to: p(9.5, 6))
    path.line(to: p(13.5, 18)); path.line(to: p(16, 12)); path.line(to: p(21, 12))
    path.lineWidth = 2.2 * scale
    path.lineCapStyle = .round
    path.lineJoinStyle = .round
    NSColor(srgbRed: 0x2E / 255, green: 0xE5 / 255, blue: 0x9D / 255, alpha: 1).setStroke()
    path.stroke()
    NSGraphicsContext.restoreGraphicsState()
    try! rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: file))
}

render(size: 180, markFraction: 0.62, to: "src/icons/apple-touch-icon.png")
render(size: 192, markFraction: 0.62, to: "src/icons/icon-192.png")
render(size: 512, markFraction: 0.62, to: "src/icons/icon-512.png")
render(size: 512, markFraction: 0.48, to: "src/icons/icon-maskable-512.png")
render(size: 32, markFraction: 0.8, to: "src/icons/favicon-32.png")
