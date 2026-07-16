// CLI wrapper for the xenv recipe package, for use by recipes/try and recipes/test.
//
// Usage:
//
//	go run ./main get  <env> <key>           # prints plaintext
//	go run ./main set  <env> <key> <value>   # writes encrypted value
//	go run ./main load <env>                 # prints KEY=value lines
package main

import (
	"fmt"
	"os"

	"xenv-recipe-go/xenv"
)

func usage() {
	fmt.Fprintln(os.Stderr, "usage: main {get|set|load} <env> [<key>] [<value>]")
	os.Exit(2)
}

func main() {
	args := os.Args[1:]
	if len(args) < 2 {
		usage()
	}

	verb := args[0]
	switch {
	case verb == "get" && len(args) == 3:
		out, err := xenv.Get(args[1], args[2])
		if err != nil {
			fmt.Fprintln(os.Stderr, "xenv:", err)
			os.Exit(1)
		}
		os.Stdout.Write(out)

	case verb == "set" && len(args) == 4:
		if err := xenv.Set(args[1], args[2], []byte(args[3])); err != nil {
			fmt.Fprintln(os.Stderr, "xenv:", err)
			os.Exit(1)
		}

	case verb == "load" && len(args) == 2:
		values, err := xenv.Load(args[1])
		if err != nil {
			fmt.Fprintln(os.Stderr, "xenv:", err)
			os.Exit(1)
		}
		for k, v := range values {
			fmt.Fprintf(os.Stdout, "%s=", k)
			os.Stdout.Write(v)
			fmt.Fprintln(os.Stdout)
		}

	default:
		usage()
	}
}
