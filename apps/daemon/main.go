package main

import (
	"fmt"
	"os"
)

func main() {
	if len(os.Args) > 1 && os.Args[1] == "dev" {
		fmt.Println("ctrluhr daemon dev mode (stub tracker)")
		fmt.Println("noop - fill me in during 05-daemon-setup.md")
		return
	}
	fmt.Println("ctrluhr daemon - no args provided. Use 'ctrluhr dev' for stub tracker.")
}
