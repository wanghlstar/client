import {app, shell, BrowserWindow, ipcMain, protocol, Tray, Menu, nativeImage} from "electron";
import {createProtocol} from "vue-cli-plugin-electron-builder/lib";
import installExtension, {VUEJS3_DEVTOOLS} from "electron-devtools-installer";
import path from 'path'
import fse from 'fs-extra'
import {execFile} from "child_process";

app.commandLine.appendSwitch('disable-gpu-sandbox');

const isDevelopment = process.env.NODE_ENV !== "production";
// Scheme must be registered before the app is ready
protocol.registerSchemesAsPrivileged([
    {scheme: "app", privileges: {secure: true, standard: true}},
]);

let mainWindow
let tray = null
let isQuitting = false
// 隐藏模式：X/Cmd+W 关闭窗口后进入（窗口隐藏 + Dock 图标移除）。
// 此状态下协议唤起/系统激活都不弹窗，保持无感；只能通过托盘恢复
let isHiddenMode = false

// ---- 协议唤起无感相关状态 ----
// launchedByUrl: 本次进程是（或曾被）jms:// 协议唤起；startHidden: 冷启动直接建隐藏窗口
let launchedByUrl = false
let startHidden = false
let lastUrlStr = ""
let lastUrlAt = 0
let autoHideTimer = null

// 兜底：手动打开窗口后切出前台时，若 2s 后仍未被用户聚焦（不在前台/未激活），
// 自动隐藏窗口 + Dock 图标。协议唤起路径直接走 hideMainWindow()，不依赖此定时器
function scheduleAutoHide() {
    if (process.platform !== "darwin") return
    if (autoHideTimer) clearTimeout(autoHideTimer)
    autoHideTimer = setTimeout(() => {
        autoHideTimer = null
        if (isQuitting) return
        if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isFocused()) {
            hideMainWindow()
        }
    }, 2000)
}

function cancelAutoHide() {
    if (autoHideTimer) {
        clearTimeout(autoHideTimer)
        autoHideTimer = null
    }
}

// macOS: 显示主窗口并恢复 Dock 图标
function showMainWindow(options) {
    const autoHide = !!(options && options.autoHide)
    if (!mainWindow || mainWindow.isDestroyed()) {
        createWindow();
    } else {
        mainWindow.show();
        mainWindow.focus();
    }
    if (process.platform === "darwin") {
        app.dock.show();
        app.setActivationPolicy("regular");
    }
    isHiddenMode = false;
    // 协议唤起的窗口排 2s 自动隐藏；用户主动打开的立即取消任何待执行的隐藏
    if (autoHide) {
        scheduleAutoHide()
    } else {
        cancelAutoHide()
    }
}

// macOS: 关闭窗口时仅隐藏窗口并移除 Dock 图标，app 保持后台运行（持续响应 jms:// 协议）
function hideMainWindow() {
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.hide();
    }
    if (process.platform === "darwin") {
        app.dock.hide();
    }
    isHiddenMode = true;
}

// 托盘图标（用户提供 Logo 裁去透明留白后生成的透明模板图）
// 1x = 18px 决定菜单栏显示尺寸 18pt；2x = 36px 保证 Retina 清晰
// setTemplateImage 让 macOS 自动适配深浅色菜单栏。注意：不要用 setSize()，会破坏图像导致托盘不可见
const TRAY_ICON_DATA_URL = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABIAAAASCAYAAABWzo5XAAADEElEQVR4nM1Ta0hTYRj+Luc7ZztnOztzOrd0W9qUaTelKFSiexLdFkpadDfoQj+yHyXS1YosukAQUZGG0YXSMAozgqIIEsPqV0YURWV5y3Wc8+i2c75YYajbz370/HpfeN+H53u+9wHgHwGO7CAAlP4ukVGAUOAZiDGiqqrRwUFV8/Vqo+eGgEZ0lALIsQCZTQiZTRw/Z1qOaXvxHpKSlAAhgjgxnkC9Do4miVKEJBFhSeS4bM8EPj+vnHU7vABDAAgByuPmQ/5rDSfUbrkfaCpVe2R1OOFfRcTtEkhKcly4rUMBlGpkXJIX6ljgv9a4orNkn8g47DOt5/bKhoJ5S5AkciTVwcc0i8vyWGx1p39YLx95RFKS9dgax8RXlh6z15/5ZChcMB1iDISFMzKTn1ymlortlRH1MYkii8TtFBKrKu47X9ygpm3FK5BoQOaykh2OpqvUem5fPetJNSIDDyOzOE7Cw/eZoYId73YS15i0rh3HF/ELcqeZS9c85/Nz+8FAUKaDIQBNghMKeh22SCFh6eyiwL2nN9Wen0qURzSgBMR1Sxut1RXvQh+/fvi+crc+9P5LDcC4T75QO6tr6+GprNuRZrt1UiGZ41Zp/r5gzKeR9LEGfm5OesKZ8hrnq1s0bu+WMibZxmGLhLnsjHhbzdEmR/N1Ku1ct0k3dYKVcdq5mN/Pz89JFzd46/zXG1dDBhPjRu9DLOilcFvHG9aTmjnwqvWO/2pDKXE7M4T8vOof+8+mBVs/9EZ5FP7W1RH62PbAcmDL676GZwd9FeczuJxJc7nJnkLfqSub1a6eTnG9t5qb6J4pX6wr1gJKMKYixpZAIqfPTcnMMG1a/hAZDdbemjuL1U7fJy43a62Qn7tr8PXbu/L52pLw53YfZAkKt7UHY192JF96HUYGnuWXzS4SC+ZVQV4P1PbusHzpdp7ytOUlZBio9SuqJvv/5C6KaCiIGAMsiRhABBmXzUxcdvtAS+s7GlDCACOodveEgKpFBXdk+oerE/QQGg0MoABAgpH2szeo9fVHp/W/xS+xCRaOeHqsggAAAABJRU5ErkJggg==";
const TRAY_ICON_DATA_URL_2X = "data:image/png;base64,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";

function createTray() {
    if (tray) {
        return tray
    }
    try {
        // 1x(18px) 决定菜单栏里的显示尺寸 18pt，再叠加 2x(36px) 表示保证 Retina 清晰
        let trayImage = nativeImage.createFromDataURL(TRAY_ICON_DATA_URL)
        try {
            trayImage.addRepresentation({
                scaleFactor: 2.0,
                width: 36,
                height: 36,
                dataURL: TRAY_ICON_DATA_URL_2X
            })
        } catch (e2) {
            console.warn("2x 托盘图标表示添加失败，回退 1x:", e2.toString())
        }
        if (trayImage.isEmpty()) {
            trayImage = nativeImage.createFromDataURL(TRAY_ICON_DATA_URL)
        }
        trayImage.setTemplateImage(true)
        tray = new Tray(trayImage)
        console.log("托盘已创建, 图标尺寸:", JSON.stringify(trayImage.getSize()))
        tray.setToolTip("JumpServer Client")
        tray.setContextMenu(Menu.buildFromTemplate([
            {label: "打开 JumpServer 客户端", click: showMainWindow},
            {type: "separator"},
            {label: "退出", click: () => { isQuitting = true; app.quit(); }},
        ]))
    } catch (e) {
        console.error("创建托盘图标失败:", e.toString())
    }
}

async function createWindow() {
    // Create the browser window.
    mainWindow = new BrowserWindow({
        width: 860,
        height: 550,
        center: true,
        // 冷启动即被协议唤起且已配置时不显示窗口，避免"闪一下"
        show: !startHidden,
        fullscreenable: false,
        resizable: false,
        transparent: true,
        titleBarStyle: 'hidden',
        titleBarOverlay: {
            color: "#1f1f1f",
            symbolColor: "#fff",
        },
        webPreferences: {
            // Use pluginOptions.nodeIntegration, leave this alone
            // See nklayman.github.io/vue-cli-plugin-electron-builder/guide/security.html#node-integration for more info
            nodeIntegration: true,
            contextIsolation: false,
        },
    });
    // startHidden 仅用于冷启动一次性建隐藏窗口，窗口创建后复位，避免后续重建窗口仍保持隐藏
    startHidden = false;

    // 用户把窗口切到前台 → 取消待执行的自动隐藏
    mainWindow.on("focus", () => {
        cancelAutoHide()
    });

    // 窗口失去前台（切到别的应用）→ 2s 后自动隐藏窗口 + Dock。
    // 规则：只要窗口不是激活状态，2s 就收起来；2s 内切回来则 focus 取消定时器
    mainWindow.on("blur", () => {
        scheduleAutoHide()
    });

    // macOS: X 按钮 / Cmd+W 关闭窗口时，仅隐藏窗口并移除 Dock 图标（app 保持后台运行）
    mainWindow.on("close", (event) => {
        if (process.platform === "darwin" && !isQuitting) {
            event.preventDefault();
            hideMainWindow();
        }
    });

    mainWindow.webContents.setWindowOpenHandler((details) => {
        shell.openExternal(details.url)
        return { action: "deny" }
    });

  if (process.env.WEBPACK_DEV_SERVER_URL) {
        // Load the url of the dev server if in development mode
        await mainWindow.loadURL(process.env.WEBPACK_DEV_SERVER_URL);
        // if (!process.env.IS_TEST) mainWindow.webContents.openDevTools()
    } else {
        createProtocol("app");
        // Load the index.html when not in development
        await mainWindow.loadURL("app://./index.html");
        // mainWindow.webContents.openDevTools()
    }
}

// Quit when all windows are closed.
app.on("window-all-closed", () => {
    // On macOS it is common for applications and their menu bar
    // to stay active until the user quits explicitly with Cmd + Q
    if (process.platform !== "darwin") {
        app.quit();
    }
});

app.on("activate", () => {
    // 隐藏模式下（协议唤起 / Cmd+Tab 等系统激活）：不弹窗，
    // 仅把可能被系统恢复的 Dock 图标再次隐藏，保持无感
    if (isHiddenMode) {
        if (process.platform === "darwin") {
            app.dock.hide();
        }
        return;
    }
    // 终端尚未配置时：任何激活都弹出窗口，引导用户完成配置
    if (!isTerminalConfigured()) {
        showMainWindow();
        return;
    }
    // 协议唤起引起的激活（含冷启动时不早于 URL 的那次 activate）：
    // 立即收起窗口 + Dock，保持无感。3s 时间窗外再 activate 才视为用户主动点 Dock 图标打开
    if (launchedByUrl && Date.now() - lastUrlAt < 3000 && isConfiguredFor(lastUrlStr)) {
        hideMainWindow();
        return;
    }
    // 已配置：Dock 图标点击 → 恢复窗口并重新显示 Dock 图标
    showMainWindow();
});

app.on("before-quit", () => {
    // Cmd+Q / 托盘退出：放行窗口关闭，app 正常退出
    isQuitting = true;
});

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.on("ready", async () => {
    if (isDevelopment && !process.env.IS_TEST) {
        // Install Vue Devtools
        try {
            await installExtension(VUEJS3_DEVTOOLS);
        } catch (e) {
            console.error("Vue Devtools failed to install:", e.toString());
        }
    }
    registerLocalResourceProtocol();

    // 冷启动检测：macOS 一般走 open-url（可能早于 ready）；个别场景 URL 会出现在 argv 里，这里兜住
    if (!launchedByUrl) {
        const arg = (process.argv || []).find(a => typeof a === "string" && a.toLowerCase().startsWith("jms://"));
        if (arg) {
            launchedByUrl = true;
            lastUrlStr = arg;
            lastUrlAt = Date.now();
            handleOpenFromUrl(arg);
        }
    }
    // 冷启动即被协议唤起、且对应客户端已配置 → 直接建隐藏窗口，全程无窗口、无 Dock（不闪一下）
    if (process.platform === "darwin" && launchedByUrl && isConfiguredFor(lastUrlStr)) {
        startHidden = true;
    }

    await createWindow();
    if (startHidden) {
        isHiddenMode = true;
        app.dock.hide();
    }
    if (process.platform === "darwin") {
        createTray();
    }
});

function registerLocalResourceProtocol() {
    protocol.registerFileProtocol("local-resource", (request, callback) => {
        const url = request.url.replace(/^local-resource:\/\//, "");
        // Decode URL to prevent errors when loading filenames with UTF-8 chars or chars like "#"
        const decodedUrl = decodeURI(url); // Needed in case URL contains spaces
        try {
            return callback(decodedUrl);
        } catch (error) {
            console.error(
                "ERROR: registerLocalResourceProtocol: Could not get file path:",
                error
            );
        }
    });
}

// Exit cleanly on request from parent process in development mode.
if (isDevelopment) {
    if (process.platform === "win32") {
        process.on("message", (data) => {
            if (data === "graceful-exit") {
                app.quit();
            }
        });
    } else {
        process.on("SIGTERM", () => {
            app.quit();
        });
    }
}


if (process.platform === "darwin") {
  if (process.defaultApp) {
    if (process.argv.length >= 2) {
      app.setAsDefaultProtocolClient('jms', process.execPath, [path.resolve(process.argv[1])])
    }
  } else {
    app.setAsDefaultProtocolClient('jms')
  }
}

const handleOpenFromUrl = (url) => {
    let subPath
    if (isDevelopment && !process.env.IS_TEST) {
        subPath = "bin"
    } else {
        subPath = process.resourcesPath + "/bin"
    }
    if (process.platform === "linux") {
        switch (process.arch) {
            case 'x32':
            case 'x64':
                subPath += "/linux-amd64"
                break;
            case 'arm':
            case 'arm64':
                subPath += "/linux-arm64"
                break;
        }
    } else if (process.platform === "darwin") {
        subPath += "/darwin"
    }
    console.log(subPath)
    let exeFilePath = path.join(subPath, 'JumpServerClient')
    const {execFile} = require('child_process')
    execFile(exeFilePath, [url], (error, stdout, stderr) => {
        if (error) {
            console.log(error);
        }
    });
}

app.on('open-url', (event, urlStr) => {
    // 连接实际由 Go sidecar（JumpServerClient 二进制）拉起本地客户端完成，
    // Electron 窗口只是配置界面——协议唤起默认完全无感，不弹窗、不恢复 Dock
    launchedByUrl = true;
    lastUrlStr = urlStr;
    lastUrlAt = Date.now();
    handleOpenFromUrl(urlStr);
    if (app.isReady()) {
        if (!isConfiguredFor(urlStr)) {
            // 未配置对应客户端：弹出窗口引导用户做配置（这种窗口不自动隐藏）
            showMainWindow();
        } else if (isHiddenMode && process.platform === "darwin") {
            // 已隐藏：系统处理协议唤起可能恢复 Dock 图标——再次隐藏，保持无感
            app.dock.hide();
        } else {
            // 已配置：协议唤起全程无感，立即收起窗口 + Dock，不闪、不等待
            hideMainWindow()
        }
    }
});

let configFilePath

let subPath
if (isDevelopment && !process.env.IS_TEST) {
    subPath = "bin"
} else {
    subPath = process.resourcesPath + "/bin"
}
configFilePath = path.join(subPath, 'config.json')

// 判断终端是否已配置（config.json 中是否存在 is_set 的终端项）。
// 未配置时协议唤起会弹出窗口引导用户做配置；已配置则保持无感
function isTerminalConfigured() {
    try {
        const data = fse.readFileSync(configFilePath, "utf8");
        const config = JSON.parse(data);
        let platform
        if (process.platform === "win32") {
            platform = "windows"
        } else if (process.platform === "darwin") {
            platform = "macos"
        } else {
            platform = "linux"
        }
        const terminals = config[platform] && config[platform].terminal;
        if (!Array.isArray(terminals)) {
            return false;
        }
        return terminals.some(item => item.is_set === true);
    } catch (e) {
        // 配置文件缺失或解析失败 → 视为未配置
        return false;
    }
}

// 资源协议 → config.json 中对应的客户端分类（与 go-client/config.json 的四类一致）
const PROTOCOL_CATEGORY = {
    ssh: "terminal", telnet: "terminal",
    sftp: "filetransfer",
    rdp: "remotedesktop",
    mysql: "databases", mariadb: "databases", postgresql: "databases",
    redis: "databases", oracle: "databases", sqlserver: "databases",
};

// jms:// 唤起链接形如 jms://<base64(JSON)>，从中解出资源协议（ssh / rdp / sftp / mysql ...）
function getProtocolFromUrl(urlStr) {
    try {
        const raw = String(urlStr).replace(/^jms:\/\//i, "").split(/[/?#]/)[0];
        const decoded = Buffer.from(raw, "base64").toString("utf8");
        return (JSON.parse(decoded) || {}).protocol || "";
    } catch (e) {
        return "";
    }
}

function isCategoryConfigured(category) {
    try {
        const config = JSON.parse(fse.readFileSync(configFilePath, "utf8"));
        const platform = process.platform === "win32"
            ? "windows"
            : (process.platform === "darwin" ? "macos" : "linux");
        const lst = config[platform] && config[platform][category];
        if (!Array.isArray(lst)) return false;
        return lst.some(item => item.is_set === true);
    } catch (e) {
        return false;
    }
}

// 本次唤起的资源对应的客户端是否已配置：
// 能识别协议就查对应分类（rdp→remotedesktop、ssh→terminal...），识别不出才退化为"终端是否已配置"
function isConfiguredFor(urlStr) {
    const category = PROTOCOL_CATEGORY[getProtocolFromUrl(urlStr)];
    if (category) {
        return isCategoryConfigured(category);
    }
    return isTerminalConfigured();
}


const callBackUrlName = 'config-reply-get'//消息发布-发布名称
//读取本地文件
ipcMain.on('config-get', function (event) {
    // 传给渲染进程数据
    fse.readFile(configFilePath, "utf8", (err, data) => {
        if (err) {
            event.sender.send(callBackUrlName, 500, "读取 config.json 文件失败");
        } else {
            event.sender.send(callBackUrlName, 200, data);
        }
    })
});


//增改本地文件
ipcMain.on('config-set', function (event, type, value) {
    value = JSON.parse(value)
    fse.readFile(configFilePath, "utf8", (err, data) => {
        if (err) {
            console.log("目标文件异常")
        } else {
            let config = JSON.parse(data);
            let platform
            if (process.platform === "win32") {
                platform = "windows"
            } else if (process.platform === "darwin") {
                platform = "macos"
            } else {
                platform = "linux"
            }
            let lst = []
            switch (type) {
                case 'sshPage':
                    lst = config[platform]['terminal']
                    break
                case 'remotePage':
                    lst = config[platform]['remotedesktop']
                    break
                case 'fileTransferPage':
                    lst = config[platform]['filetransfer']
                    break
                case 'databasesPage':
                    lst = config[platform]['databases']
                    break
            }
            lst.forEach(item => {
                if (value.is_default) {
                    item.is_default = false
                }
                if (item.match_first.length > 0) {
                    item.match_first = item.match_first.filter(item => !value.match_first.includes(item))
                }
                if (item.name === value.name) {
                    item.path = value.path
                    item.is_default = value.is_default
                    item.is_set = value.is_set
                    item.match_first = value.match_first
                }
            })
            const config_str = JSON.stringify(config)
            fse.writeFileSync(configFilePath, config_str, "utf8")
            event.sender.send(callBackUrlName, 200, config_str);
        }
    })
});
