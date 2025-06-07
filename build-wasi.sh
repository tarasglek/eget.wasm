#!/bin/sh
GOOS=wasip1 GOARCH=wasm go build -ldflags="-s -w" -trimpath
