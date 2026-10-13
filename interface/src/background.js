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

// macOS: 显示主窗口并恢复 Dock 图标
function showMainWindow() {
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
    createWindow();
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
    // 连接实际由 Go sidecar（JumpServerClient 二进制）拉起本地终端完成，
    // Electron 窗口只是配置界面——协议唤起默认完全无感，不弹窗、不恢复 Dock
    handleOpenFromUrl(urlStr);
    if (app.isReady()) {
        if (!isTerminalConfigured()) {
            // 首次/未配置：弹出窗口引导用户做配置
            showMainWindow();
        } else if (isHiddenMode && process.platform === "darwin") {
            // 系统处理协议唤起时会激活 app，可能恢复 Dock 图标——这里再次隐藏，保持无感
            app.dock.hide();
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
