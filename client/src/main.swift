import AppKit
import WebKit
import Foundation

// MARK: - 落盘日志（注意：插值必须是单反斜杠 \( ，写成 \\( 会生成反斜杠开头的非法路径 → 静默写不进去）
func log(_ s: String) {
    let home = NSHomeDirectory()
    let dir  = "\(home)/Library/Logs"
    let path = "\(dir)/costgate-client.log"
    if !FileManager.default.fileExists(atPath: dir) {
        try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
    }
    // 注意：直接用 "\(Date())" 打出来的是 UTC，比本地早 8 小时，排障会看错时间
    let f = DateFormatter()
    f.locale = Locale(identifier: "zh_CN")
    f.timeZone = TimeZone.current
    f.dateFormat = "yyyy-MM-dd HH:mm:ss"
    let line = "\(f.string(from: Date())) \(s)\n"
    if FileManager.default.fileExists(atPath: path),
       let h = FileHandle(forWritingAtPath: path) {
        h.seekToEndOfFile(); h.write(Data(line.utf8)); try? h.synchronize()
    } else {
        try? line.write(toFile: path, atomically: true, encoding: .utf8)
    }
    fputs(line, stderr)
}

// MARK: - 常量
/// ⚠️ 开源脱敏：本机绝对路径不能写死。
/// 底座目录按「环境变量 MULTIPROXY_DIR → 若干候选目录探测（含 codex-proxy/proxy.js 落点校验）」解析。
/// 别人 clone 后把目录改成任意名字都能跑；本机（~/Documents/AI项目/multi-proxy）命中第一个候选。
let PROXY_DIR: String = {
    for key in ["COSTGATE_DIR", "MULTIPROXY_DIR"] {
        if let d = ProcessInfo.processInfo.environment[key], !d.isEmpty { return d }
    }
    let fm = FileManager.default
    let home = NSHomeDirectory()
    let candidates = [
        home + "/Documents/AI项目/costgate",
        home + "/Documents/AI项目/multi-proxy",   // 改名前的本地目录名，留着兼容
        home + "/Documents/costgate",
        home + "/Documents/multi-proxy",
        home + "/costgate",
        home + "/multi-proxy",
        home + "/Developer/costgate",
        "/opt/costgate",
    ]
    for c in candidates {
        var isDir: ObjCBool = true
        if fm.fileExists(atPath: c, isDirectory: &isDir), isDir.boolValue,
           fm.fileExists(atPath: c + "/codex-proxy/proxy.js") { return c }
    }
    return candidates[0]
}()
let MANAGE      = "\(PROXY_DIR)/manage.sh"
let CODEX_DIR   = "\(PROXY_DIR)/codex-proxy"
let PROXY_JS    = "\(CODEX_DIR)/proxy.js"
/// node：环境变量 MULTIPROXY_NODE → 托管版本候选 → which node。
let NODE: String = {
    for key in ["COSTGATE_NODE", "MULTIPROXY_NODE"] {
        if let n = ProcessInfo.processInfo.environment[key], !n.isEmpty { return n }
    }
    let fm = FileManager.default
    let home = NSHomeDirectory()
    for c in [home + "/.workbuddy/binaries/node/versions/22.22.2-3/bin/node",
              home + "/.workbuddy/binaries/node/current/bin/node",
              "/opt/homebrew/bin/node", "/usr/local/bin/node"] {
        if fm.isExecutableFile(atPath: c) { return c }
    }
    return "node"
}()
let HEALTH      = "http://127.0.0.1:18790/health"
let DASHBOARD   = "http://127.0.0.1:18792/dashboard.html"
let APP_NAME    = "costgate"
/// 版本与构建号从自己的 Info.plist 读（build.sh 从 VERSION + git HEAD 写进去），
/// 代码里不重复一份，免得哪天两处对不上。
let APP_VERSION = (Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String) ?? "0.0.0"
let APP_COMMIT  = (Bundle.main.infoDictionary?["CGCommit"] as? String) ?? "dev"
let AGENT_ID    = "com.sifking.costgate.client"
let DSH_APP     = "DeepSeek Harness"
let PATCH_FILE  = "\(NSHomeDirectory())/.dsh/profiles/desktop/cordis.patch.yml"
let SETTINGS    = "\(NSHomeDirectory())/.dsh/settings.yaml.imported"
let LAUNCHDIR   = "\(NSHomeDirectory())/Library/LaunchAgents"
let AGENT_PLIST = "\(LAUNCHDIR)/\(AGENT_ID).plist"
// —— 崩溃自愈（watchdog）：本壳拉起的底座崩溃则退避自动重启；附着模式绝不碰外部进程 ——
let MAX_RESTART        = 5   // 连续自动重启上限，超过则放弃并提示手动
let WATCHDOG_INTERVAL: TimeInterval = 5   // 探活周期（秒），间隔本身即自然退避

// MARK: - 工具
/// 子进程环境：只给必要的，别把 Shell 会话的自定义变量（BASH_ENV 之类）传染过去。
/// PATH 里的 node/python3 用本机的 WorkBuddy 托管版本（/opt/homebrew/bin 下没有 node）。
func childEnvironment() -> [String: String] {
    let home = NSHomeDirectory()
    // node/python 目录同样做候选探测，别写死本机托管版本路径（开源后默认回退通用 PATH）
    let nodeDir  = (NODE as NSString).deletingLastPathComponent
    let pythonDir: String = {
        let c = home + "/.workbuddy/binaries/python/versions/3.13.12/bin"
        if FileManager.default.isExecutableFile(atPath: c + "/python3") { return c }
        return "/opt/homebrew/bin"
    }()
    return [
        "PATH": (nodeDir.isEmpty ? "" : nodeDir + ":")
                 + (pythonDir.isEmpty ? "" : pythonDir + ":")
                 + "/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin",
        "HOME": home,
        "SHELL": "/bin/bash",
        "TERM": "dumb",
        "LANG": "zh_CN.UTF-8",
        "USER": NSUserName(),
        "LOGNAME": NSUserName(),
    ]
}

/// ⚠️ 踩过的坑：原来用 Pipe + readDataToEndOfFile() 读输出，
/// 结果卡死 —— manage.sh 里 nohup 起来的一堆 node/python 守护进程继承了管道的写端，
/// 一直往里灌日志把 16KB 管道缓冲区写满，manage.sh 自己卡在 write，
/// 父进程又卡在 readDataToEndOfFile 等 EOF，两边互等死锁（底座起不来、DSH 也开不了）。
/// 改法：子进程 stdout/stderr 直接指向临时文件（非管道 ⇒ 没有 EOF 概念 ⇒ 不会卡），
/// 父进程只在「子进程自己退出」后才去读文件。
func runShell(_ cmd: String, timeout: TimeInterval = 90) -> String {
    let dir = "\(NSHomeDirectory())/Library/Logs/costgate-client-tmp"
    try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
    let outPath = "\(dir)/\(UUID().uuidString).txt"
    FileManager.default.createFile(atPath: outPath, contents: nil)
    guard let fh = FileHandle(forWritingAtPath: outPath) else { return "" }
    defer { try? fh.close(); try? FileManager.default.removeItem(atPath: outPath) }

    let t0 = Date()
    log("runShell -> \(cmd.prefix(80))")
    let t = Process()
    t.launchPath = "/bin/bash"
    t.arguments = ["-c", cmd]
    // ⚠️ 关键：必须给子进程一套「干净环境」。
    // 直接继承父进程环境的话，会把 Shell 会话里的 BASH_ENV（指向 agent 的 shim 脚本）
    // 一起带过去 —— bash -c 会先 source 它，shim 在 GUI 应用进程里会卡死，
    // 表现就是「双击客户端底座起不来、日志只有第一行 startBase」。
    t.environment = childEnvironment()
    t.standardOutput = fh
    t.standardError = fh
    do { try t.run() } catch { return "" }

    // 只等「这个 bash 自己」退出，不等它 fork 出去的守护进程。
    // ⚠️ 别用 Timer.scheduledTimer 轮询 —— 本函数常在后台队列里跑，后台队列没有 run loop，
    // Timer 一次都不触发，只能干等到 90s 信号量超时才返回。用忙等最稳。
    let deadline = Date().addingTimeInterval(timeout)
    while t.isRunning && Date() < deadline {
        Thread.sleep(forTimeInterval: 0.3)
    }
    if t.isRunning {
        log("runShell timeout \(timeout)s -> 杀掉: \(cmd.prefix(60))")
        t.terminate()
    }
    t.waitUntilExit()
    let dt = Date().timeIntervalSince(t0)
    log("runShell 子进程已退出 用时=\(String(format: "%.1f", dt))s cmd=\(cmd.prefix(50))")

    let d = FileManager.default.contents(atPath: outPath) ?? Data()
    return String(data: d, encoding: .utf8) ?? ""
}

func fileMtime(_ path: String) -> Date? {
    guard FileManager.default.fileExists(atPath: path) else { return nil }
    return (try? FileManager.default.attributesOfItem(atPath: path)[.modificationDate] as? Date) ?? nil
}

/// 配置"最后被改"的时间：两处入口都算（agnes 有两份独立配置源）
func configMtime() -> Date? {
    let a = fileMtime(PATCH_FILE), b = fileMtime(SETTINGS)
    guard let x = a, let y = b else { return a ?? b }
    return x > y ? x : y
}

/// macOS 的 ps 没有 `etimes` 这个关键字（只有 Linux 有），写了会报
/// "ps: etimes: keyword not found" 且**只吐 pid + command 两列**，
/// 于是下游 "parts.count >= 3" 永远不成立 ⇒ 永远判"DSH 没起来" ⇒ 永远打不开 DSH。
/// macOS 用 `etime`，格式 `mm:ss` / `hh:mm:ss` / `dd-hh:mm:ss`。
func parseEtime(_ s: Substring) -> Double? {
    var secs: Double = 0
    var tok = s
    if let d = tok.split(separator: "-", omittingEmptySubsequences: true).first,
       tok.contains("-"), let days = Double(d) { secs += days * 86400; tok = tok.split(separator: "-").dropFirst().first ?? tok }
    let cols = tok.split(separator: ":", omittingEmptySubsequences: true)
    guard let last = cols.last, let second = Double(last) else { return nil }
    secs += second
    if cols.count >= 2, let m = Double(cols[cols.count - 2]) { secs += m * 60 }
    if cols.count >= 3, let h = Double(cols[cols.count - 3]) { secs += h * 3600 }
    return secs
}

/// DSH 主进程 pid + 已运行秒数。ago = -1 表示判断不了（宁可不重启，也不能乱杀维护者开着的东西）。
/// ⚠️ 历史坑串：① 早先用 `ps lstart` 解析日期 → split 吃双空格 ⇒ 只有 5 段 ⇒ 恒判"旧配置"狂杀 DSH；
///              ② 后来改 `etimes`（Linux 关键字，macOS 不认）⇒ 永远 nil ⇒ 永远打不开 DSH。
///              现在用 `etime` + parseEtime 自己算秒，不碰任何日期解析。
func dshInfo() -> (pid: Int, ago: Double)? {
    // 过滤 Helper：Electron 的 helper 进程路径里也含 Contents/MacOS/，混进来 pid 就不是主进程
    let out = runShell("ps -eo pid,etime,command | grep -i 'DeepSeek Harness' | grep -v grep | grep -v Helper | head -1")
    let parts = out.split(separator: " ", maxSplits: 2, omittingEmptySubsequences: true)
    guard parts.count >= 3, let pid = Int(parts[0]) else { return nil }
    guard let ago = parseEtime(parts[1]) else { return (pid, -1) }
    return (pid, ago)
}

/// 配置最后被改距今几秒；nil = 读不到
func configAgeSeconds() -> Double? {
    guard let cm = configMtime() else { return nil }
    return Date().timeIntervalSince(cm)
}

func healthOK() -> Bool {
    guard let url = URL(string: HEALTH) else { return false }
    var req = URLRequest(url: url); req.timeoutInterval = 3
    var ok = false
    let sem = DispatchSemaphore(value: 0)
    let task = URLSession.shared.dataTask(with: req) { _, resp, _ in
        if let r = resp as? HTTPURLResponse, r.statusCode == 200 { ok = true }
        sem.signal()
    }
    task.resume()
    _ = sem.wait(timeout: .now() + 4)
    log("health -> \(ok)")
    return ok
}

/// ⚠️ 别再从客户端调 `manage.sh start codex`：同样的命令在终端里 15 秒跑完，
/// 从 GUI 客户端的 bash 子进程里跑就会卡死（输出 0 字节、进程不退出，实测复现多次）。
/// 绕开 shell，客户端直接用 node 起 proxy.js，行为可控、日志自己能收。
func startBase() -> (ok: Bool, output: String) {
    if healthOK() { return (true, "网关本来就在跑") }
    guard FileManager.default.fileExists(atPath: PROXY_JS) else {
        log("startBase 缺 proxy.js: \(PROXY_JS)")
        return (false, "找不到 \(PROXY_JS)，请跑一次依赖安装")
    }

    let logDir = "\(NSHomeDirectory())/Library/Logs/costgate-client"
    try? FileManager.default.createDirectory(atPath: logDir, withIntermediateDirectories: true)
    let logPath = "\(logDir)/codex-proxy.log"
    FileManager.default.createFile(atPath: logPath, contents: nil)
    guard let fh = FileHandle(forWritingAtPath: logPath) else {
        return (false, "打不开日志 \(logPath)")
    }

    let t = Process()
    t.launchPath = NODE
    t.arguments = ["proxy.js"]
    t.currentDirectoryPath = CODEX_DIR
    t.environment = childEnvironment()
    t.standardOutput = fh
    t.standardError = fh
    do {
        log("startBase: 起 node proxy.js（cwd=\(CODEX_DIR)）")
        try t.run()
    } catch {
        log("startBase 起 node 失败: \(error)")
        return (false, "起代理失败：\(error)")
    }

    var waited: TimeInterval = 0
    while waited < 45 {
        if healthOK() {
            log("startBase ok=true 用时 \(Int(waited))s")
            return (true, "网关已启动，日志：\(logPath)")
        }
        Thread.sleep(forTimeInterval: 2); waited += 2
        log("startBase 等 health \(Int(waited))s")
    }
    return (false, "等了 45 秒没起来，看日志 \(logPath)")
}

/// 这个 pid 还活着吗（kill 前必查，防误杀）
func pidAlive(_ pid: Int) -> Bool {
    runShell("ps -p \(pid) -o pid=").trimmingCharacters(in: .whitespacesAndNewlines).count > 0
}

/// 打开 DSH。返回是否真起来了。
/// ⚠️ 两个坑：
/// 1) `open -a '/全路径/xxx.app'`（带 -a 又给全路径）macOS 不认，会静默失败；
///    要么 `open '/全路径/xxx.app'`（直接给路径），要么 `open -a 'xxx'`（只给不带 .app 的名字）。
/// 2) Electron 冷启动要 15~25 秒，等 3 秒判断必然是「没起来」，必须轮询到 25 秒。
@discardableResult
func openDSHApp(pollSeconds: TimeInterval = 25) -> Bool {
    _ = runShell("open '/Applications/DeepSeek Harness.app' 2>/dev/null")
    var waited: TimeInterval = 0
    while waited < pollSeconds {
        sleep(2); waited += 2
        log("openDSHApp 等待进程 \(Int(waited))s")
        if dshInfo() != nil { return true }
    }
    return false
}

// MARK: - 首启数据清理（first-launch-cleanup；从 desktop/first-launch-cleanup.js 语义移植）
// 门控：默认 off=shadow（只算清单 + 打一行日志，零落盘、零删除）；report=写 manifest；on=真删。
// 读取优先级：显式参数（测试）> 环境变量 MPX_FIRSTLAUNCH_CLEANUP > 默认 off。
// force：显式参数 > 环境变量 MPX_CLEANUP_FORCE=1 > 默认 false（force 跳过首启标记判断）。
// 安全不变式（全部保留）：
//  · 绝不删 NEVER_TOUCH_REPO（proxy.db / override-audit.jsonl / .encryption-key / logs）
//  · homedir 用户态目录只报告、绝不删
//  · *.bak-* 仅扫 repo 工作树（跳过 node_modules/.git/repo 根 logs）、近期写过（<2min）跳过、
//    只删「删完变空」的目录（非递归 rmdir，保留还有活文件的目录）
//  · 门控/标记读写都 try/catch，任何异常静默吞掉，绝不影响启动流程
let MANIFEST_BASENAME = "first-launch-cleanup.json"
let MARKER_BASENAME   = ".first-launch-cleanup-done"
let RECENT_WRITE: TimeInterval = 120   // 2 分钟；写入中的文件（活跃 .db-wal / 正在写日志）绝不碰
let DELETABLE_DIR: [String] = ["codex-proxy/trace", "codex-proxy/logs"]
let DELETABLE_FILE: [String] = [
    "cursor-proxy/data/proxy.db-wal",
    "cursor-proxy/data/proxy.db-shm",
    "cursor-proxy/data/pricing-cache.json",
]
let NEVER_TOUCH_REPO: [String] = [
    "cursor-proxy/data/proxy.db",
    "cursor-proxy/data/override-audit.jsonl",
    "cursor-proxy/.encryption-key",
    "logs",
]
let STATE_DIRS_HOMEDIR: [String] = [".costgate", ".multi-proxy-manager", ".multi-proxy"]

private func resolveGate(explicit: String?) -> String {
    if let g = explicit, !g.isEmpty { return g }
    if let e = ProcessInfo.processInfo.environment["MPX_FIRSTLAUNCH_CLEANUP"], !e.isEmpty { return e }
    return "off"
}
private func resolveForce(explicit: Bool?) -> Bool {
    if let f = explicit { return f }
    return ProcessInfo.processInfo.environment["MPX_CLEANUP_FORCE"] == "1"
}
private func mtimeDate(_ path: String) -> Date? {
    let attrs = try? FileManager.default.attributesOfItem(atPath: path)
    return attrs?[.modificationDate] as? Date
}
private func isRecentWritten(_ path: String) -> Bool {
    guard let m = mtimeDate(path) else { return false }
    return Date().timeIntervalSince(m) < RECENT_WRITE
}
/// 仅当目录为空时删除（语义 == JS fs.rmdir，绝不递归）；列不出/非空一律不动（保守）。
@discardableResult
private func removeDirIfEmpty(_ path: String) -> Bool {
    let fm = FileManager.default
    guard let entries = try? fm.contentsOfDirectory(atPath: path) else { return false }
    guard entries.isEmpty else { return false }   // 还有活文件 → 保留
    try? fm.removeItem(atPath: path)
    return !fm.fileExists(atPath: path)
}
/// 递归收集 name 含 ".bak-" 的文件（跳过 node_modules / .git / repo 根 logs；绝不递归进依赖）。
private func collectBakFiles(root: String) -> [String] {
    let fm = FileManager.default
    var out: [String] = []
    func walk(_ dir: String) {
        guard let entries = try? fm.contentsOfDirectory(atPath: dir) else { return }
        for name in entries {
            if name == "node_modules" || name == ".git" { continue }
            let p = dir + "/" + name
            if p == root + "/logs" { continue }   // 绝不碰 repo 根运行日志目录
            var isDir: ObjCBool = false
            guard fm.fileExists(atPath: p, isDirectory: &isDir) else { continue }
            if isDir.boolValue { walk(p) }
            else if name.contains(".bak-") { out.append(p) }
        }
    }
    walk(root)
    return out
}
private func relPath(_ abs: String, root: String) -> String {
    if abs.hasPrefix(root + "/") { return String(abs.dropFirst(root.count + 1)) }
    return abs
}

/// 首启清理主入口。返回一行摘要（同时写进日志）。绝不 throw、绝不 crash。
@discardableResult
func runFirstLaunchCleanup(gate: String? = nil, force: Bool? = nil) -> String {
    let gate0 = resolveGate(explicit: gate)
    let force0 = resolveForce(explicit: force)
    let doDelete = gate0 == "on"
    let writeManifest = gate0 != "off"

    let fm = FileManager.default
    let repoRoot = PROXY_DIR
    let home = NSHomeDirectory()
    let stateBase = home + "/.multi-proxy-manager"
    let manifestPath = stateBase + "/" + MANIFEST_BASENAME
    let markerPath   = stateBase + "/" + MARKER_BASENAME

    // 首启标记：marker 文件已存在 且 非 force → 本轮降级「只报告、不删」（幂等）。
    // 对齐原始 JS：fs.existsSync(markerPath) && !force；marker 内容（JSON/时间戳）不参与判断。
    let alreadyDone = !force0 && fm.fileExists(atPath: markerPath)
    let effectiveDelete = doDelete && !alreadyDone

    var deletedFiles: [String] = []
    var keptRecentFiles: [String] = []
    var failedDeletes: [String] = []

    // —— A. 可删（repo 工作树 dev 残留）——
    for rel in DELETABLE_DIR {
        let p = repoRoot + "/" + rel
        var isDir: ObjCBool = false
        guard fm.fileExists(atPath: p, isDirectory: &isDir), isDir.boolValue else { continue }
        if let entries = try? fm.contentsOfDirectory(atPath: p) {
            for name in entries {
                let fp = p + "/" + name
                var isSub: ObjCBool = false
                guard fm.fileExists(atPath: fp, isDirectory: &isSub) else { continue }
                if isSub.boolValue { continue }   // 子目录不动（只删文件，非递归）
                if isRecentWritten(fp) {
                    keptRecentFiles.append(fp)
                } else if effectiveDelete {
                    do { try fm.removeItem(atPath: fp); deletedFiles.append(fp) }
                    catch { failedDeletes.append(fp) }
                }
            }
        }
        if effectiveDelete { _ = removeDirIfEmpty(p) }
    }
    for rel in DELETABLE_FILE {
        let p = repoRoot + "/" + rel
        guard fm.fileExists(atPath: p) else { continue }
        if isRecentWritten(p) {
            keptRecentFiles.append(p)
        } else if effectiveDelete {
            do { try fm.removeItem(atPath: p); deletedFiles.append(p) }
            catch { failedDeletes.append(p) }
        }
    }
    for abs in collectBakFiles(root: repoRoot) {
        if isRecentWritten(abs) {
            keptRecentFiles.append(abs)
        } else if effectiveDelete {
            do { try fm.removeItem(atPath: abs); deletedFiles.append(abs) }
            catch { failedDeletes.append(abs) }
        }
    }

    // —— B. 绝不碰（只报告）——
    let neverTouched = NEVER_TOUCH_REPO.filter { fm.fileExists(atPath: repoRoot + "/" + $0) }

    // —— C. 用户态（homedir，只报告、绝不删）——
    let userStates = STATE_DIRS_HOMEDIR.filter { fm.fileExists(atPath: home + "/" + $0) }

    // —— manifest（仅 report / on；off=shadow 零落盘）——
    if writeManifest {
        _ = try? fm.createDirectory(atPath: stateBase, withIntermediateDirectories: true)
        let manifest: [String: Any] = [
            "deleted": deletedFiles.map { relPath($0, root: repoRoot) },
            "keptRecent": keptRecentFiles.map { relPath($0, root: repoRoot) },
            "failed": failedDeletes.map { relPath($0, root: repoRoot) },
            "neverTouched": neverTouched,
            "userStatesReportedOnly": userStates,
            "generatedAt": Date().timeIntervalSince1970,
        ]
        if let data = try? JSONSerialization.data(withJSONObject: manifest, options: [.prettyPrinted]) {
            try? data.write(to: URL(fileURLWithPath: manifestPath))
        }
    }
    // —— marker：实际发生删除才写（后续启动据此跳过）——
    if effectiveDelete && !deletedFiles.isEmpty {
        _ = try? fm.createDirectory(atPath: stateBase, withIntermediateDirectories: true)
        let marker: [String: Any] = [
            "deleted": deletedFiles.map { relPath($0, root: repoRoot) },
            "at": Date().timeIntervalSince1970,
        ]
        if let data = try? JSONSerialization.data(withJSONObject: marker) {
            try? data.write(to: URL(fileURLWithPath: markerPath))
        }
    }

    let summary = "[first-launch-cleanup] gate=\(gate0)"
        + (alreadyDone ? "（首启已删过，本轮只报告）" : "")
        + " deleted=\(deletedFiles.count)"
        + " keptRecent=\(keptRecentFiles.count)"
        + " failed=\(failedDeletes.count)"
        + " neverTouched=\(neverTouched.count)"
        + " userStates=\(userStates.count)"
    log(summary)
    return summary
}

// MARK: - 应用委托
final class AppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate {
    var window: NSWindow!
    var statusLabel: NSTextField!
    var webView: WKWebView!
    var spinner: NSProgressIndicator!
    // 崩溃自愈状态（常量见文件头 MAX_RESTART / WATCHDOG_INTERVAL）
    var selfStartedBase = false    // 底座是否本壳拉起（false = 外部附着，绝不碰）
    var baseEverHealthy = false    // 底座启动后是否健康过（只在"起过又掉"时自愈）
    var restartAttempts = 0        // 距最近一次"健康"的连续重启次数（恢复即清零）
    var isQuitting = false         // 用户主动退出（此时 watchdog 停止重启）
    let watchdogQueue = DispatchQueue(label: "costgate.base.watchdog")  // 串行队列：探活与重启不交错
    var watchdogActive = false   // watchdog 运行标志（防重复启动）

    func applicationDidFinishLaunching(_ notification: Notification) {
        buildUI()
        log("app launched")
        // 首启数据清理：默认 off=shadow（零落盘、零删除）；report/on 由 MPX_FIRSTLAUNCH_CLEANUP 门控。
        // 独立后台队列跑，不阻塞窗口/底座启动。
        DispatchQueue.global(qos: .utility).async { runFirstLaunchCleanup() }
        checkAndStart()
    }

    func buildUI() {
        let w = 1080, h = 760
        window = NSWindow(contentRect: NSRect(x: 260, y: 140, width: w, height: h),
                          styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
                          backing: .buffered, defer: false)
        window.title = APP_NAME
        window.titlebarAppearsTransparent = true
        window.center()

        let content = NSView(frame: NSRect(x: 0, y: 0, width: w, height: h))
        window.contentView = content

        statusLabel = NSTextField(frame: NSRect(x: 20, y: h - 48, width: w - 60, height: 32))
        statusLabel.isBezeled = false
        statusLabel.drawsBackground = false
        statusLabel.isEditable = false
        statusLabel.isSelectable = false
        statusLabel.font = NSFont.systemFont(ofSize: 13, weight: .semibold)
        statusLabel.stringValue = "正在检查网关…"
        content.addSubview(statusLabel)

        spinner = NSProgressIndicator(frame: NSRect(x: w - 52, y: h - 42, width: 20, height: 20))
        spinner.style = .spinning
        spinner.startAnimation(nil)
        content.addSubview(spinner)

        webView = WKWebView(frame: NSRect(x: 0, y: 0, width: w, height: h - 54))
        webView.autoresizingMask = [.width, .height]
        webView.isHidden = true
        webView.navigationDelegate = self   // 渲染进程崩溃 → didTerminate → 自动重载面板
        content.addSubview(webView)

        buildMenu()
    }

    func buildMenu() {
        let appMenu = NSMenu()
        // 2026-11-13：DSH 那几件从主菜单收进「可选集成」子菜单。
        // 理由：DSH 是可选的下游，没装的人看到这一条只会疑惑「这跟我有什么关系」。
        // 主菜单只留「让网关跑起来」相关的动作。
        appMenu.addItem(NSMenuItem(title: "检查并启动网关", action: #selector(recheck), keyEquivalent: "r"))
        appMenu.addItem(NSMenuItem(title: "重新加载面板", action: #selector(reloadPanel), keyEquivalent: "R"))
        let agentItem = NSMenuItem(title: "开机自动启动本客户端", action: #selector(toggleAgent), keyEquivalent: "s")
        agentItem.state = FileManager.default.fileExists(atPath: AGENT_PLIST) ? .on : .off
        appMenu.addItem(agentItem)

        appMenu.addItem(NSMenuItem.separator())
        let integrations = NSMenuItem(title: "可选集成", action: nil, keyEquivalent: "")
        let integrationsMenu = NSMenu()
        integrationsMenu.addItem(NSMenuItem(title: "打开 DSH（若已安装）", action: #selector(openDSH), keyEquivalent: "d"))
        integrations.submenu = integrationsMenu
        appMenu.addItem(integrations)

        appMenu.addItem(NSMenuItem.separator())
        appMenu.addItem(NSMenuItem(title: "关于 \(APP_NAME)", action: #selector(about), keyEquivalent: ""))
        appMenu.addItem(NSMenuItem(title: "退出", action: #selector(quitApp), keyEquivalent: "q"))
        let appItem = NSMenuItem()
        appItem.submenu = appMenu
        let main = NSMenu()
        main.addItem(appItem)
        NSApp.mainMenu = main
    }

    /// 状态刷新一律回主线程（整套检查跑在后台队列里，setStatus 会被频繁调用）
    func setStatus(_ s: String, ok: Bool) {
        DispatchQueue.main.async {
            self.statusLabel.stringValue = s
            self.statusLabel.textColor = ok
                ? NSColor(red: 0.05, green: 0.55, blue: 0.25, alpha: 1)
                : .systemRed
            self.spinner.stopAnimation(nil)
            self.spinner.isHidden = true
        }
    }

    // MARK: 核心流程
    // 1) 底座没起就起；2) DSH 若还在跑旧配置（进程启动早于配置 mtime）就重启它；3) DSH 没开就给它开；4) 绿了才加载面板
    @objc func checkAndStart() {
        log("checkAndStart begin")
        // 先把窗口顶出来，别让维护者盯着桌面空白
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        spinner.startAnimation(nil); spinner.isHidden = false
        statusLabel.stringValue = "正在检查网关…"
        statusLabel.textColor = .labelColor
        webView.isHidden = true
        // 整套检查（起底座 / 等 DSH 冷启动）最长 40s+，绝不能占主线程，否则窗口一直白屏
        DispatchQueue.global(qos: .userInitiated).async { self.checkAndStartBody() }
    }

    func checkAndStartBody() {
        var msg = ""
        var okFlag = false

        if healthOK() {
            // 附着模式：底座已在跑（外部 / 原生 / LaunchAgent）——绝不碰，退出时不杀
            selfStartedBase = false
            baseEverHealthy = true
            msg = "✅ 网关运行中（127.0.0.1:18790，附着模式）"
            okFlag = true
        } else {
            setStatus("网关未运行，正在启动…", ok: true)
            let r = startBase()
            if healthOK() {
                // 拉起模式：底座由本壳 spawn → watchdog 接管，崩溃时自动重启
                selfStartedBase = true
                baseEverHealthy = true
                msg = "✅ 网关已启动（127.0.0.1:18790）"
                if !r.output.isEmpty { msg += "\n" + trim(r.output, max: 160) }
                okFlag = true
            } else {
                // 拉起失败：底座"从没起来"，不认领、不无限重试，交给手动 manage.sh
                msg = "❌ 网关启动失败。\n手动自查：cd \(PROXY_DIR) && bash ./manage.sh start codex"
                if !r.output.isEmpty { msg += "\n\n" + trim(r.output, max: 300) }
            }
        }

        // —— 判 DSH 是不是吃的旧配置：DSH 已跑秒数 < 配置改完至今秒数 = 旧 ——
        // 安全原则：判断不了就别动它，宁可不重启，也不能乱杀维护者开着的东西。
        guard let dsh = dshInfo() else {
            msg += openDSHApp() ? "\n已帮你打开 DSH 客户端 ✅" : "\n⚠️ DSH 没拉起来，请手动点开 DeepSeek Harness"
            finish(msg, ok: okFlag)
            return
        }

        let dshAgo = dsh.ago
        guard dshAgo >= 0, pidAlive(dsh.pid), let cfgAge = configAgeSeconds() else {
            log("dsh pid=\(dsh.pid) 时间算不出来 -> 不动它")
            msg += "\nDSH 在跑（判断不了新旧，没动它）"
            finish(msg, ok: okFlag)
            return
        }

        log("dsh pid=\(dsh.pid) ago=\(dshAgo)s configAge=\(cfgAge)s")
        if dshAgo < cfgAge {
            msg += "\nDSH 吃的是旧配置，正在重启…"
            setStatus(msg, ok: okFlag)
            _ = runShell("kill \(dsh.pid) >/dev/null 2>&1; sleep 3")
            log("killed dsh pid=\(dsh.pid)")
            let opened = openDSHApp()
            log("reopened dsh -> \(opened)")
            msg += opened
                ? "\nDSH 已用新配置重启 ✅"
                : "\n⚠️ 已重启 DSH 但没拉起来，请手动点开 DSH"
        } else {
            msg += "\nDSH 已加载新配置 ✅"
        }

        finish(msg, ok: okFlag)
    }

    func finish(_ msg: String, ok: Bool) {
        log("checkAndStart done: \(msg)")
        DispatchQueue.main.async {
            self.setStatusNow(msg, ok: ok)
            self.showPanel(ok: ok)
            if ok { self.startWatchdog() }   // 只在绿了之后开看门狗，自愈"起过又掉"
        }
    }

    func setStatusNow(_ s: String, ok: Bool) {
        statusLabel.stringValue = s
        statusLabel.textColor = ok
            ? NSColor(red: 0.05, green: 0.55, blue: 0.25, alpha: 1)
            : .systemRed
        spinner.stopAnimation(nil)
        spinner.isHidden = true
    }

    func showPanel(ok: Bool) {
        if ok {
            webView.isHidden = false
            webView.load(URLRequest(url: URL(string: DASHBOARD)!))
        }
    }

    @objc func recheck() { checkAndStart() }

    @objc func openDSH() {
        log("openDSH")
        DispatchQueue.global().async {
            if !healthOK() { _ = startBase() }
            _ = runShell("open '/Applications/DeepSeek Harness.app' 2>/dev/null")
            DispatchQueue.main.async {
                self.setStatusNow("已发指令打开 DSH（冷启动约 15~25 秒）", ok: true)
                self.window.makeKeyAndOrderFront(nil)
                NSApp.activate(ignoringOtherApps: true)
            }
        }
    }

    @objc func reloadPanel() {
        if healthOK() { webView.load(URLRequest(url: URL(string: DASHBOARD)!)) }
        else { checkAndStart() }
    }

    @objc func quitApp() {
        isQuitting = true
        stopWatchdog()   // 退出时停止自愈；已拉起的 node 底座是 detached 进程，保持常驻
        log("quitApp")
        NSApplication.shared.terminate(nil)
    }

    @objc func toggleAgent() {
        let fm = FileManager.default
        if fm.fileExists(atPath: AGENT_PLIST) {
            _ = runShell("launchctl unload '\(AGENT_PLIST)' 2>/dev/null; rm -f '\(AGENT_PLIST)'")
            setStatus("已关闭开机自动启动", ok: true)
        } else {
            try? fm.createDirectory(atPath: LAUNCHDIR, withIntermediateDirectories: true)
            let plist = """
            <?xml version="1.0" encoding="UTF-8"?>
            <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
            <plist version="1.0">
            <dict>
              <key>Label</key><string>\(AGENT_ID)</string>
              <key>ProgramArguments</key>
              <array><string>open</string><string>-a</string><string>\(APP_NAME)</string></array>
              <key>RunAtLoad</key><true/>
              <key>KeepAlive</key><false/>
              <key>ProcessType</key><string>Background</string>
            </dict>
            </plist>
            """
            do {
                try plist.write(toFile: AGENT_PLIST, atomically: true, encoding: .utf8)
                _ = runShell("launchctl load '\(AGENT_PLIST)' 2>&1")
                setStatus("已开启开机自动启动（下次登录生效）", ok: true)
            } catch {
                setStatus("写 LaunchAgent 失败：\(error.localizedDescription)", ok: false)
            }
        }
        buildMenu()
    }

    @objc func about() {
        let a = NSAlert()
        a.messageText = "\(APP_NAME) \(APP_VERSION)（\(APP_COMMIT)）"
        a.informativeText = """
        这个窗口是 costgate 的外壳：它保证本地网关在跑，然后把管理面板装进来。
        账本在 ~/.multi-proxy-manager/ledger.jsonl，一行一笔，纯文本，可以直接 grep。

        网关统一入口 127.0.0.1:18880，按端口区分 agent（codex 18790 / claude 18791 / cursor 18794 …），
        所以「谁花的」不用猜，看请求落在哪个端口。

        如果你装了 DSH，它还会顺手把 DSH 指到新配置；没装就不管这一块。
        """
        a.addButton(withTitle: "好")
        a.runModal()
    }

    // MARK: - 崩溃自愈（watchdog）

    /// 启动看门狗：后台串行队列每 WATCHDOG_INTERVAL 秒重探底座。
    /// 本壳拉起的底座掉线 → 自动重拉（连续最多 MAX_RESTART 次）；附着模式绝不碰外部进程。
    func startWatchdog() {
        guard !watchdogActive else { return }
        watchdogActive = true
        scheduleWatchdogTick()
        log("watchdog 启动 间隔=\(Int(WATCHDOG_INTERVAL))s selfStarted=\(selfStartedBase)")
    }

    /// 递归排 tick：当前 tick（含 startBase 的 45s 阻塞等待）跑完才排下一次，天然串行不重叠
    func scheduleWatchdogTick() {
        watchdogQueue.asyncAfter(deadline: .now() + WATCHDOG_INTERVAL) { [weak self] in
            guard let self = self, self.watchdogActive, !self.isQuitting else { return }
            self.watchdogTick()
            self.scheduleWatchdogTick()
        }
    }

    func stopWatchdog() {
        watchdogActive = false
    }

    /// 在 watchdogQueue 串行队列上执行：探活 + 自愈决策
    func watchdogTick() {
        guard !isQuitting else { return }
        if healthOK() {
            restartAttempts = 0   // 恢复健康，清零连续重启计数
            return
        }
        // 底座掉线（18790 不通）
        guard selfStartedBase else {
            // 附着模式：不代管外部进程的重启，只提示用户
            log("watchdog: 附着的外部底座已停（18790 不通），不代为重启")
            DispatchQueue.main.async {
                self.setStatusNow("⚠️ 底座（附着）已停止，点「检查并启动底座」重连", ok: false)
            }
            return
        }
        guard baseEverHealthy else {
            // "从没起来"不算崩溃（首次拉起失败），不无限重试
            return
        }
        restartAttempts += 1
        if restartAttempts > MAX_RESTART {
            log("watchdog: 底座连续 \(MAX_RESTART) 次重启仍未恢复，放弃自愈")
            DispatchQueue.main.async {
                self.setStatusNow("❌ 底座反复崩溃（\(MAX_RESTART) 次重启无果），请手动：cd \(PROXY_DIR) && bash ./manage.sh start codex", ok: false)
            }
            return
        }
        log("watchdog: 底座掉线，第 \(restartAttempts) 次自动重启…")
        DispatchQueue.main.async {
            self.setStatusNow("底座掉线，自动重启中（第 \(self.restartAttempts)/\(MAX_RESTART) 次）…", ok: false)
        }
        _ = startBase()   // 同串行队列重拉，串行保证不重叠
        if healthOK() {
            log("watchdog: 重启成功")
            restartAttempts = 0
        }
    }

    // MARK: - 渲染进程崩溃自愈（WKWebView）

    /// 渲染（Web 内容）进程异常退出 → 自动重载面板。macOS 10.11+ 标准 WKNavigationDelegate 回调。
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        log("WKWebView 渲染进程异常退出，自动重载面板")
        DispatchQueue.main.async {
            if healthOK() {
                self.webView.load(URLRequest(url: URL(string: DASHBOARD)!))
            } else {
                // 后端也掉线了 → 走整套检查流程，别只 reload 一个白面板
                self.checkAndStart()
            }
        }
    }

    func trim(_ s: String, max: Int) -> String {
        let t = s.trimmingCharacters(in: .whitespacesAndNewlines)
        return t.count > max ? String(t.prefix(max)) + "…" : t
    }
}

// MARK: - main
let application = NSApplication.shared
let delegate = AppDelegate()
application.delegate = delegate
application.setActivationPolicy(.regular)
application.run()
