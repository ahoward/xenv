// CLI wrapper for the xenv loader package, for use by loaders/test.sh.
//
// Usage:
//   go run ./loaders/go/main <env>           # prints KEY=value lines
//   go run ./loaders/go/main <env> <key>     # prints just that value
package main

import (
	"fmt"
	"os"

	"xenv-loader-go/xenv"
)

func main() {
	if len(os.Args) < 2 {
		fmt.Fprintln(os.Stderr, "usage: main <env> [<key>]")
		os.Exit(2)
	}
	envName := os.Args[1]

	if len(os.Args) >= 3 {
		out, err := xenv.DecryptOne(envName, os.Args[2])
		if err != nil {
			fmt.Fprintln(os.Stderr, "xenv:", err)
			os.Exit(1)
		}
		os.Stdout.Write(out)
		return
	}

	values, err := xenv.Load(envName)
	if err != nil {
		fmt.Fprintln(os.Stderr, "xenv:", err)
		os.Exit(1)
	}
	for k, v := range values {
		fmt.Fprintf(os.Stdout, "%s=", k)
		os.Stdout.Write(v)
		fmt.Fprintln(os.Stdout)
	}
}
