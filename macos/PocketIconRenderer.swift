import AppKit
import Foundation

guard CommandLine.arguments.count == 2 else {
    fputs("usage: PocketIconRenderer OUTPUT.png\n", stderr)
    exit(2)
}

let size = NSSize(width: 1024, height: 1024)
let image = NSImage(size: size)
image.lockFocus()
NSGraphicsContext.current?.imageInterpolation = .high

let tile = NSBezierPath(roundedRect: NSRect(x: 64, y: 64, width: 896, height: 896), xRadius: 210, yRadius: 210)
NSColor(calibratedRed: 20 / 255, green: 37 / 255, blue: 29 / 255, alpha: 1).setFill()
tile.fill()
NSColor(calibratedRed: 69 / 255, green: 200 / 255, blue: 138 / 255, alpha: 0.28).setStroke()
tile.lineWidth = 10
tile.stroke()

NSColor(calibratedRed: 69 / 255, green: 200 / 255, blue: 138 / 255, alpha: 1).setStroke()
let pocket = NSBezierPath()
pocket.lineWidth = 68
pocket.lineCapStyle = .round
pocket.lineJoinStyle = .round
pocket.move(to: NSPoint(x: 240, y: 735))
pocket.line(to: NSPoint(x: 784, y: 735))
pocket.line(to: NSPoint(x: 784, y: 452))
pocket.curve(to: NSPoint(x: 512, y: 228), controlPoint1: NSPoint(x: 784, y: 310), controlPoint2: NSPoint(x: 676, y: 228))
pocket.curve(to: NSPoint(x: 240, y: 452), controlPoint1: NSPoint(x: 348, y: 228), controlPoint2: NSPoint(x: 240, y: 310))
pocket.close()
pocket.stroke()

let prompt = NSBezierPath()
prompt.lineWidth = 68
prompt.lineCapStyle = .round
prompt.lineJoinStyle = .round
prompt.move(to: NSPoint(x: 350, y: 610))
prompt.line(to: NSPoint(x: 455, y: 512))
prompt.line(to: NSPoint(x: 350, y: 414))
prompt.move(to: NSPoint(x: 545, y: 414))
prompt.line(to: NSPoint(x: 674, y: 414))
prompt.stroke()

image.unlockFocus()
guard let tiff = image.tiffRepresentation,
      let bitmap = NSBitmapImageRep(data: tiff),
      let png = bitmap.representation(using: .png, properties: [:]) else {
    fputs("could not render icon\n", stderr)
    exit(1)
}
try png.write(to: URL(fileURLWithPath: CommandLine.arguments[1]), options: .atomic)
