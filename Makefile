# GNU Make (3.81+ on Unix, 4+ on Windows); run from the root or use make -C.
.DEFAULT_GOAL := help

# Native packages share a staging directory, even when make is invoked with -j.
.NOTPARALLEL:

NODE ?= node
PYTHON ?= python3
MACOS_ARGS ?=

ifeq ($(OS),Windows_NT)
SHELL := cmd.exe
.SHELLFLAGS := /D /S /C
HOST_OS := Windows
NPM ?= npm.cmd
else
SHELL := /bin/sh
HOST_OS := $(shell uname -s)
NPM ?= npm
endif

.PHONY: help install check-node build-web dev package package-macos package-debug package-windows install-windows-cross

help:
	@echo make install                Install locked web, runtime and Cargo dependencies
	@echo make build-web              Build web/dist on Windows or Unix
	@echo make dev                    Run the macOS client with Vite hot updates
	@echo make package                Build the release package for this host
	@echo make package-macos          Build macOS ARM64 .app and .dmg
	@echo make package-debug          Build macOS ARM64 debug .app
	@echo make package-windows        Build Windows x64 NSIS installer
	@echo make install-windows-cross  Install macOS tools for cross-compiling Windows
	@echo Prerequisites on PATH: GNU Make, Node 26.11.1 with npm, Rust 1.92.0 and Google Chrome.
	@echo macOS: Xcode command-line tools, Python 3, CMake and Ninja.
	@echo Windows: x64 VS Developer shell with C++ Build Tools and Windows SDK.
	@echo Windows also needs CMake, Ninja and LLVM on PATH.
	@echo macOS cross-builds additionally need Homebrew - run install-windows-cross.
	@echo Linux and other Unix hosts support install and build-web only.
	@echo Set MACOS_ARGS=--no-dmg to build only the release .app.
	@echo macOS output: target/release/bundle and debug output: target/debug/bundle.
	@echo Windows output: desktop/.scratch/native-windows-target/x86_64-pc-windows-msvc/release/bundle/nsis.

check-node:
	@"$(NODE)" -e "if (process.versions.node !== '26.11.1') throw new Error('Use Node 26.11.1, required by desktop/scripts/prepare.mjs')"

install: check-node
	rustup show
	"$(NPM)" ci --prefix web
	"$(NPM)" ci --prefix desktop/runtime
	cargo fetch --locked

build-web: check-node
	"$(NPM)" --prefix web run build

ifeq ($(HOST_OS),Windows)
package: package-windows
else ifeq ($(HOST_OS),Darwin)
package: package-macos
else
package:
	@echo Desktop packaging supports macOS ARM64 and Windows x64 only. Run make build-web on this host.
	@exit 1
endif

ifeq ($(HOST_OS),Darwin)
dev: check-node
	"$(PYTHON)" desktop/scripts/build-native-macos.py --dev

package-macos: check-node
	"$(PYTHON)" desktop/scripts/build-native-macos.py $(MACOS_ARGS)

package-debug: check-node
	"$(PYTHON)" desktop/scripts/build-native-macos.py --debug --no-dmg

install-windows-cross: check-node
	@"$(NODE)" -e "if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('Windows cross-builds require macOS ARM64')"
	brew install llvm lld nsis cmake ninja
	rustup target add x86_64-pc-windows-msvc
	cargo install cargo-xwin --locked
else
dev package-macos package-debug install-windows-cross:
	@echo This target requires macOS ARM64.
	@exit 1
endif

ifneq ($(filter Windows Darwin,$(HOST_OS)),)
package-windows: check-node
	"$(NODE)" desktop/scripts/build-native-windows.mjs
else
package-windows:
	@echo Windows packaging requires Windows x64 or macOS ARM64.
	@exit 1
endif
