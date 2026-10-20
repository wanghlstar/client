package awaken

import (
	"go-client/global"
	"go-client/pkg/config"
	"io/ioutil"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

/*{
	"id": "f",
	"value": "q",
	"protocol": "ssh",
	"command": "xxx"
	"file": {
		"name": "name",
		"content": "content",
	}
}*/

type File struct {
	Name    string `json:"name"`
	Content string `json:"content"`
}

type Endpoint struct {
	Host string `json:"host"`
	Port int    `json:"port"`
}

type Token struct {
	ID    string `json:"id"`
	Value string `json:"value"`
}

type Asset struct {
	ID       string `json:"id"`
	Category string `json:"category"`
	Type     string `json:"type"`
	Name     string `json:"name"`
	Address  string `json:"address"`
	DBInfo   `json:"info"`
}

type DBInfo struct {
	DBName           string `json:"db_name"`
	UseSsl           string `json:"use_ssl"`
	AllowInvalidCert string `json:"allow_invalid_cert"`
}

type Info struct {
	Version  string `json:"version"`
	Name     string `json:"name"`
	Protocol string `json:"protocol"`
	Command  string `json:"command"`
	Asset    `json:"asset"`
	Endpoint `json:"endpoint"`
	Token    `json:"token"`
	File     `json:"file"`
}

type Rouse struct {
	Info
}

func (r *Rouse) getUserName() string {
	username := r.Token.ID
	if r.Protocol == "ssh" || r.Protocol == "sftp" {
		username = "JMS-" + username
	}
	return username
}

func (r *Rouse) getName() string {
	name, _ := url.QueryUnescape(r.Name)
	return strings.Replace(name, " ", "", -1)
}

func rdpTempDir() string {
	return filepath.Join(os.TempDir(), "jumpserver-client-rdp")
}

func removeRdpFiles(dir string) {
	re := regexp.MustCompile("(?i).*\\.rdp$")
	files, _ := ioutil.ReadDir(dir)
	for _, v := range files {
		if !v.IsDir() && re.MatchString(v.Name()) {
			_ = os.Remove(filepath.Join(dir, v.Name()))
		}
	}
}

func removeCurRdpFile() {
	removeRdpFiles(rdpTempDir())
	removeRdpFiles(filepath.Dir(os.Args[0]))
}

func (r *Rouse) HandleRDP(appConfig *config.AppConfig) {
	removeCurRdpFile()
	fileName, _ := url.QueryUnescape(r.File.Name)
	safeName := filepath.Base(fileName)
	if safeName == "." || safeName == "" {
		safeName = "jumpserver"
	}
	tempDir := rdpTempDir()
	if err := os.MkdirAll(tempDir, 0700); err != nil {
		global.LOG.Error(err.Error())
		return
	}
	filePath := filepath.Join(tempDir, safeName+".rdp")
	err := ioutil.WriteFile(filePath, []byte(r.Content), 0600)
	if err != nil {
		global.LOG.Error(err.Error())
		return
	}
	cmd := handleRDP(r, filePath, appConfig)
	cmd.Run()
}

func (r *Rouse) HandleSSH(appConfig *config.AppConfig) {
	cmd := handleSSH(r, appConfig)
	cmd.Run()
}

func (r *Rouse) HandleDB(appConfig *config.AppConfig) {
	cmd := handleDB(r, appConfig)
	cmd.Run()
}

func (r *Rouse) HandleCommand(appConfig *config.AppConfig) {
	cmd := handleCommand(r, appConfig)
	cmd.Run()
}

func (r *Rouse) Run() {
	protocol := r.Protocol
	appConfig := config.GetConf()
	if r.Command == "" {
		switch protocol {
		case "rdp":
			r.HandleRDP(&appConfig)
		case "ssh", "sftp", "telnet":
			r.HandleSSH(&appConfig)
		case "mysql", "mariadb", "postgresql", "redis", "oracle", "sqlserver":
			r.HandleDB(&appConfig)
		}
	} else {
		r.HandleCommand(&appConfig)
	}

}
