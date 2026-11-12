// costgate — Copyright © 2026 sif-king (Jason)
// Licensed under AGPL-3.0 (source) + Commercial license (see LICENSE-COMMERCIAL.md).
//
// 生成 macOS 应用图标：与 public/favicon.svg 同一套几何（六边形门 + 一条账 + 对勾），
// 但按 macOS 图标栅格（1024 画布 / 824 圆角矩形 / 半径 185）重排，而不是把 64px SVG 直接放大。
// 用法：swift client/tools/make-icon.swift <输出目录>   → 产出 iconset/ 由 iconutil 打成 .icns

import AppKit
import CoreGraphics
import Foundation
import ImageIO

let outDir = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "/tmp/costgate-iconset"
try? FileManager.default.createDirectory(atPath: outDir, withIntermediateDirectories: true)

let S: CGFloat = 1024          // 画布
let bodyInset: CGFloat = 100   // macOS 图标内容区（824）
let bodySide = S - bodyInset * 2
let bodyRadius: CGFloat = 185

func color(_ r: CGFloat, _ g: CGFloat, _ b: CGFloat, _ a: CGFloat = 1) -> CGColor {
    CGColor(srgbRed: r / 255, green: g / 255, blue: b / 255, alpha: a)
}

func makeContext(_ px: Int) -> CGContext {
    let cs = CGColorSpace(name: CGColorSpace.sRGB)!
    let ctx = CGContext(data: nil, width: px, height: px, bitsPerComponent: 8,
                        bytesPerRow: 0, space: cs,
                        bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
    ctx.interpolationQuality = .high
    ctx.setAllowsAntialiasing(true)
    return ctx
}

func drawIcon(into ctx: CGContext, px: Int) {
    let k = CGFloat(px) / S
    ctx.scaleBy(x: k, y: k)

    // 背景：圆角矩形 + 蓝色对角渐变（与 favicon 的 #3b82f6 → #1d4ed8 一致）
    let bodyRect = CGRect(x: bodyInset, y: bodyInset, width: bodySide, height: bodySide)
    let bodyPath = CGPath(roundedRect: bodyRect, cornerWidth: bodyRadius,
                          cornerHeight: bodyRadius, transform: nil)
    ctx.saveGState()
    ctx.addPath(bodyPath)
    ctx.clip()
    let grad = CGGradient(colorsSpace: CGColorSpace(name: CGColorSpace.sRGB)!,
                          colors: [color(59, 130, 246), color(29, 78, 216)] as CFArray,
                          locations: [0, 1])!
    ctx.drawLinearGradient(grad,
                           start: CGPoint(x: bodyRect.minX, y: bodyRect.maxY),
                           end: CGPoint(x: bodyRect.maxX, y: bodyRect.minY),
                           options: [])
    ctx.restoreGState()

    // 内层微光：顶部一条极淡的白色渐变，避免大面积纯色发闷
    ctx.saveGState()
    ctx.addPath(bodyPath)
    ctx.clip()
    let sheen = CGGradient(colorsSpace: CGColorSpace(name: CGColorSpace.sRGB)!,
                           colors: [color(255, 255, 255, 0.14), color(255, 255, 255, 0)] as CFArray,
                           locations: [0, 1])!
    ctx.drawLinearGradient(sheen,
                           start: CGPoint(x: 0, y: bodyRect.maxY),
                           end: CGPoint(x: 0, y: bodyRect.midY),
                           options: [])
    ctx.restoreGState()

    // 字形：把 favicon.svg 的 64 空间原图搬到内容区中央。
    // 🔴 SVG 的 y 轴朝下、CoreGraphics 朝上 —— 必须整体翻转，否则字形上下镜像。
    // 字形在 64 空间的实际包围盒（含描边）是 x 15.3…54.7 / y 18.3…45.7，中心 (35, 32)，
    // 按这个中心对齐，而不是按画布中心 32 —— 否则会偏右。
    let glyphSide = bodySide * 0.70
    let gScale = glyphSide / 64
    let originX = bodyInset + (bodySide - glyphSide) / 2
    let originY = bodyInset + (bodySide - glyphSide) / 2
    ctx.saveGState()
    ctx.translateBy(x: originX + glyphSide / 2, y: originY + glyphSide / 2)  // 先落到内容区中心
    ctx.scaleBy(x: gScale, y: -gScale)                    // 翻成 SVG 的 y 轴朝下
    ctx.translateBy(x: -35.0, y: -32)                     // 再按字形包围盒中心对齐

    ctx.setLineCap(.round)
    ctx.setLineJoin(.round)

    // 门框：一个朝右开口的方括号「[」（白）——上半段横 + 左半圆 + 下半段横，
    // 比纯半圆更像门框，小尺寸下也不会被看成字母 C。
    ctx.setStrokeColor(color(255, 255, 255))
    ctx.setLineWidth(5.4)
    let gate = CGMutablePath()
    gate.move(to: CGPoint(x: 37, y: 20))
    gate.addLine(to: CGPoint(x: 30, y: 20))
    gate.addCurve(to: CGPoint(x: 18, y: 32),
                  control1: CGPoint(x: 23.4, y: 20), control2: CGPoint(x: 18, y: 25.4))
    gate.addCurve(to: CGPoint(x: 30, y: 44),
                  control1: CGPoint(x: 18, y: 38.6), control2: CGPoint(x: 23.4, y: 44))
    gate.addLine(to: CGPoint(x: 37, y: 44))
    ctx.addPath(gate)
    ctx.strokePath()

    // 一条账：从门里横穿出去（白）
    ctx.setLineWidth(3.6)
    ctx.move(to: CGPoint(x: 30, y: 32))
    ctx.addLine(to: CGPoint(x: 50, y: 32))
    ctx.strokePath()

    // 对勾：这笔账核过了（绿）。压在账条上方、不与账条相交，
    // 否则 32px 缩下去看不出是勾，只会看到账条上长了个绿疙瘩。
    ctx.setStrokeColor(color(52, 211, 153))
    ctx.setLineWidth(3.4)
    let tick = CGMutablePath()
    tick.move(to: CGPoint(x: 43, y: 27))
    tick.addLine(to: CGPoint(x: 46, y: 30))
    tick.addLine(to: CGPoint(x: 53, y: 21))
    ctx.addPath(tick)
    ctx.strokePath()

    ctx.restoreGState()
}

let sizes: [(Int, String)] = [
    (16, "icon_16x16"), (32, "icon_16x16@2x"),
    (32, "icon_32x32"), (64, "icon_32x32@2x"),
    (128, "icon_128x128"), (256, "icon_128x128@2x"),
    (256, "icon_256x256"), (512, "icon_256x256@2x"),
    (512, "icon_512x512"), (1024, "icon_512x512@2x"),
]

for (px, name) in sizes {
    let ctx = makeContext(px)
    drawIcon(into: ctx, px: px)
    guard let img = ctx.makeImage() else { continue }
    let url = URL(fileURLWithPath: "\(outDir)/\(name).png")
    guard let dest = CGImageDestinationCreateWithURL(url as CFURL, "public.png" as CFString, 1, nil) else { continue }
    CGImageDestinationAddImage(dest, img, nil)
    CGImageDestinationFinalize(dest)
}

print("iconset: \(outDir)")
