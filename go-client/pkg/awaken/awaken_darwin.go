package awaken

import (
	"fmt"
	"go-client/global"
	"go-client/pkg/config"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"syscall"
	"time"
)

func getCommandFromArgs(connectInfo map[string]string, argFormat string) string {
	for key, value := range connectInfo {
		argFormat = strings.Replace(argFormat, "{"+key+"}", value, 1)
	}
	return argFormat
}

func selectedRDPApp(cfg *config.AppConfig) *config.AppItem {
	if cfg == nil {
		return nil
	}
	for i := range cfg.MacOS.RemoteDesktop {
		app := &cfg.MacOS.RemoteDesktop[i]
		if app.IsActive() && app.Path != "" {
			if _, err := os.Stat(app.Path); err == nil {
				return app
			}
		}
	}
	for i := range cfg.MacOS.RemoteDesktop {
		app := &cfg.MacOS.RemoteDesktop[i]
		if app.IsSet && app.Path != "" {
			if _, err := os.Stat(app.Path); err == nil {
				return app
			}
		}
	}
	return nil
}

func rdpTargetPort(filePath string) string {
	data, err := os.ReadFile(filePath)
	if err != nil {
		return "3389"
	}
	for _, line := range strings.Split(string(data), "\n") {
		if !strings.HasPrefix(line, "full address:s:") {
			continue
		}
		addr := strings.TrimSpace(strings.TrimPrefix(line, "full address:s:"))
		if i := strings.LastIndex(addr, ":"); i >= 0 {
			if _, err := strconv.Atoi(addr[i+1:]); err == nil {
				return addr[i+1:]
			}
		}
	}
	return "3389"
}

func rdpInstancePids(appPath string) []int {
	pattern := "^" + regexp.QuoteMeta(strings.TrimRight(appPath, "/")) + "/Contents/MacOS/[^/]+$"
	out, err := exec.Command("/usr/bin/pgrep", "-f", pattern).Output()
	if err != nil {
		return nil
	}
	var pids []int
	for _, field := range strings.Fields(string(out)) {
		if pid, err := strconv.Atoi(field); err == nil {
			pids = append(pids, pid)
		}
	}
	return pids
}

func rdpHasSession(pid int, port string) bool {
	out, err := exec.Command("/usr/sbin/lsof", "-nP", "-a", "-p", strconv.Itoa(pid),
		"-iTCP:"+port, "-sTCP:ESTABLISHED").Output()
	return err == nil && len(out) > 0
}

func rdpHasAnySession(pid int) bool {
	out, err := exec.Command("/usr/sbin/lsof", "-nP", "-a", "-p", strconv.Itoa(pid),
		"-iTCP", "-sTCP:ESTABLISHED").Output()
	return err == nil && len(out) > 0
}

func spawnRDPWatcher(appPath, port string, ignore []int) {
	exe, err := os.Executable()
	if err != nil {
		return
	}
	ids := make([]string, len(ignore))
	for i, pid := range ignore {
		ids[i] = strconv.Itoa(pid)
	}
	cmd := exec.Command(exe, "--watch-rdp", appPath, port, strings.Join(ids, ","))
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	if devnull, err := os.OpenFile(os.DevNull, os.O_RDWR, 0); err == nil {
		cmd.Stdin, cmd.Stdout, cmd.Stderr = devnull, devnull, devnull
	}
	cmd.Start()
}

func WatchRDPInstance(appPath, port, ignoreCSV string) {
	ignore := map[int]bool{}
	for _, s := range strings.Split(ignoreCSV, ",") {
		if pid, err := strconv.Atoi(s); err == nil {
			ignore[pid] = true
		}
	}
	target := 0
	for i := 0; i < 40 && target == 0; i++ {
		for _, pid := range rdpInstancePids(appPath) {
			if !ignore[pid] {
				target = pid
				break
			}
		}
		if target == 0 {
			time.Sleep(500 * time.Millisecond)
		}
	}
	if target == 0 {
		return
	}
	seen, idle := false, 0
	start := time.Now()
	for {
		if syscall.Kill(target, 0) != nil {
			return
		}
		if rdpHasSession(target, port) || rdpHasAnySession(target) {
			seen, idle = true, 0
		} else if seen {
			idle++
			if idle >= 15 {
				syscall.Kill(target, syscall.SIGTERM)
				return
			}
		} else if time.Since(start) > 2*time.Minute {
			syscall.Kill(target, syscall.SIGTERM)
			return
		}
		time.Sleep(2 * time.Second)
	}
}

func awakenRDPCommand(filePath string, cfg *config.AppConfig) *exec.Cmd {
	global.LOG.Debug(filePath)
	app := selectedRDPApp(cfg)
	if app != nil && app.Path != "" {
		args := []string{"-a", app.Path, filePath}
		if pids := rdpInstancePids(app.Path); len(pids) > 0 {
			port := rdpTargetPort(filePath)
			idle := 0
			for _, pid := range pids {
				if !rdpHasSession(pid, port) {
					idle++
				}
			}
			if idle == 0 {
				args = append([]string{"-n"}, args...)
				spawnRDPWatcher(app.Path, port, pids)
			}
		}
		return exec.Command("/usr/bin/open", args...)
	}
	return exec.Command("/usr/bin/open", "-b", "com.microsoft.rdc.macos", filePath)
}

func awakenSSHCommand(r *Rouse, cfg *config.AppConfig) *exec.Cmd {
	var appItem *config.AppItem
	var appLst []config.AppItem
	switch r.Protocol {
	case "ssh", "telnet":
		r.Protocol = "ssh"
		appLst = cfg.MacOS.Terminal
	case "sftp":
		appLst = cfg.MacOS.FileTransfer
	}

	for _, app := range appLst {
		if app.IsActive() && app.IsSupportProtocol(r.Protocol) {
			appItem = &app
			break
		}
	}
	if appItem == nil {
		return nil
	}
	var cmd *exec.Cmd
	connectMap := map[string]string{
		"name":     r.getName(),
		"protocol": r.Protocol,
		"username": r.getUserName(),
		"value":    r.Value,
		"host":     r.Host,
		"port":     strconv.Itoa(r.Port),
	}

	if appItem.IsInternal {
		currentPath := filepath.Dir(os.Args[0])
		commands := getCommandFromArgs(connectMap, appItem.ArgFormat)
		clientPath := filepath.Join(currentPath, "client")
		if appItem.Name == "iterm" {
			itermCmd := fmt.Sprintf(`%s %s`, clientPath, commands)

			scriptPath := filepath.Join(currentPath, "Scripts", "iterm2_loader.scpt")
			//command = fmt.Sprintf(`%s "%s"`, scriptPath, command)
			cmd = exec.Command("osascript", "-s", "h", scriptPath, itermCmd, "0")
		} else {
			cmd = exec.Command(
				"osascript", "-s", "h", "-e", fmt.Sprintf(`tell application "%s" to do script "%s %s" activate`,
					appItem.DisplayName, clientPath, commands),
			)
		}

	} else {
		var appPath string
		appPath = appItem.Path
		commands := getCommandFromArgs(connectMap, appItem.ArgFormat)
		appPath = appItem.Path
		cmd = exec.Command(appPath, strings.Split(commands, " ")...)
	}
	return cmd
}

func awakenDBCommand(r *Rouse, cfg *config.AppConfig) *exec.Cmd {
	var appItem *config.AppItem
	appLst := cfg.MacOS.Databases
	for _, app := range appLst {
		if app.IsSet && app.IsMatchProtocol(r.Protocol) {
			appItem = &app
			break
		}
	}
	if appItem == nil {
		return nil
	}
	appPath := appItem.Path
	connectMap := map[string]string{
		"name":     r.getName(),
		"protocol": r.Protocol,
		"username": r.getUserName(),
		"value":    r.Value,
		"host":     r.Host,
		"port":     strconv.Itoa(r.Port),
		"dbname":   r.DBName,
	}
	if appItem.IsInternal {
		var argFormat string
		switch r.Protocol {
		case "redis":
			argFormat = "redis-cli -h {host} -p {port} -a {username}@{value}"
		case "oracle":
			argFormat = "sqlplus {username}/{value}@{host}:{port}/{dbname}"
		case "postgresql":
			argFormat = "psql 'user={username} password={value} host={host} dbname={dbname} port={port}'"
		case "mysql", "mariadb":
			argFormat = "mysql -u {username} -p{value} -h {host} -P {port} {dbname}"
		case "sqlserver":
			argFormat = "sqlcmd -S {host},{port} -U {username} -P {value} -d {dbname}"
		}
		commands := getCommandFromArgs(connectMap, argFormat)
		cmd := exec.Command(
			"osascript", "-s", "h", "-e", fmt.Sprintf(`tell application "%s" to do script "%s" activate`,
				appItem.DisplayName, commands),
		)
		return cmd
	} else {
		if r.Protocol == "sqlserver" {
			connectMap["protocol"] = "mssql_jdbc_ms_new"
		}
		appPath = appItem.Path
		commands := getCommandFromArgs(connectMap, appItem.ArgFormat)
		return exec.Command(appPath, strings.Split(commands, " ")...)
	}
}

func awakenOtherCommand(r *Rouse, cfg *config.AppConfig) *exec.Cmd {
	var command string
	if r.Protocol == "ssh" {
		currentPath := filepath.Dir(os.Args[0])
		clientPath := filepath.Join(currentPath, "client")
		command = fmt.Sprintf("%s %s -P %s", clientPath, r.Command, r.Value)
	} else {
		command = r.Command
	}
	cmd := exec.Command(
		"osascript", "-s", "h",
		"-e", fmt.Sprintf(`tell application "%s" to do script "%s"`, "Terminal", command),
	)
	return cmd
}
