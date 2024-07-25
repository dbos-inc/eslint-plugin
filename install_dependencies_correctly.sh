#!/bin/bash

# This script exists to install the dependencies for this plugin during development (so only use it if you're developing the plugin itself!).
# I have this script so that finding the right versions for all the dependencies will be easier (NPM will find versions that work with each other).

do_install() {
  eval "npm i $1 $2"
}

rm -r node_modules
rm -r package-lock.json
rm -r dist

set -e

typescript_eslint_packages="typescript-eslint @typescript-eslint/eslint-plugin @typescript-eslint/parser @typescript-eslint/utils"

plain="@types/node eslint-plugin-no-secrets eslint-plugin-security"
peer="typescript ts-morph eslint $typescript_eslint_packages"
dev="vitest @typescript-eslint/rule-tester$tseslv $typescript_eslint_packages"
optional="@rollup/rollup-linux-x64-gnu"

eval "npm remove $plain $peer $dev $optional"

do_install "$plain"
do_install "$peer" "--save-peer"
do_install "$dev" "--save-dev"
do_install "$optional" "--save-optional"
