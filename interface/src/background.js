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
// 进程启动时刻：用于区分"冷启动被协议唤起"与"运行中收到唤起"
const appStartTime = Date.now()

// 协议唤起后的静默处理：
// - 冷启动头几秒收到 URL：本次进程就是被它唤起的，直接收起窗口 + Dock，彻底无感
//   （此时窗口往往被系统激活处于前台，等 2s 判断聚焦会漏掉，所以必须直接收）
// - 运行中收到 URL：客户端已在跑，唤起本就不弹窗；万一窗口露出来且不在前台，2s 后自动隐藏
function silenceAfterUrlInvoke() {
    if (process.platform !== "darwin") return
    if (Date.now() - appStartTime < 3000) {
        hideMainWindow()
    } else {
        scheduleAutoHide()
    }
}

// 兜底：因协议唤起而露出的窗口，若 2s 后仍未被用户聚焦（不在前台/未激活），
// 自动隐藏窗口 + Dock 图标，做到"无感"。用户主动打开（托盘/Dock 点击）的窗口不受影响
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

// 托盘图标（36x36 @2x = 18pt，JumpServer 官方 Logo 单色剪影；setTemplateImage 让 macOS 自动适配深浅色菜单栏）
// 注：官方原版内嵌的 16x16 base64 PNG 实为损坏数据（解码后仅十余个随机像素，图标不可见），
// 此处改用官方品牌 Logo（build/icons/256x256.png 的 alpha 通道）重新制作的模板图像
const TRAY_ICON_DATA_URL = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACQAAAAkCAYAAADhAJiYAAAAqElEQVR42u2YwQqAMAxD9/8/He87CG1eZmEOelOTliZkrvWfS48mEdlrDJHPiKlQY4hEiQksTClVsGMTq4LYxFyQBb5zBAQjpWAjtqrIRlC5I3uSIhXzIQXNsYqJ+Ep3ua0oQU2lRYhUVnmKApQVyU6kUiKq63wMIdKJEdTzZdnTPmQtNe1DuOypqdjxQ8EGXmOA0zmRGObKfmQESd7Nxtxe7/vZEM3QD8FiKPRy1Z0tAAAAAElFTkSuQmCC";

function createTray() {
    if (tray) {
        return tray
    }
    try {
        const trayImage = nativeImage.createFromDataURL(TRAY_ICON_DATA_URL)
        trayImage.setTemplateImage(true)
        tray = new Tray(trayImage)
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

    // 用户把窗口切到前台 → 取消待执行的自动隐藏
    mainWindow.on("focus", () => {
        cancelAutoHide()
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
    // 协议唤起引起的激活（含冷启动时不早于 URL 的那次 activate）：不主动弹窗；
    // 窗口若被系统带出来，2s 后仍未被聚焦就自动隐藏。
    // 3s 时间窗之外再 activate 视为用户主动打开（点 Dock 图标），正常显示
    if (launchedByUrl && Date.now() - lastUrlAt < 3000 && isConfiguredFor(lastUrlStr)) {
        if (process.platform === "darwin") {
            app.dock.hide();
        }
        silenceAfterUrlInvoke();
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
            // 客户端已配置：唤起本身不需要界面，按冷启动/运行中分别处理
            silenceAfterUrlInvoke()
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
