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

peer_and_dev_packages="typescript ts-morph typescript-eslint @typescript-eslint/eslint-plugin @typescript-eslint/parser @typescript-eslint/utils"

plain="@types/node eslint-plugin-no-secrets eslint-plugin-security"
peer="eslint $peer_and_dev_packages"
dev="vitest @typescript-eslint/rule-tester $peer_and_dev_packages"
optional="@rollup/rollup-linux-x64-gnu"

eval "npm remove $plain $peer $dev $optional"

do_install "$plain"
do_install "$peer" "--save-peer"
do_install "$dev" "--save-dev"
do_install "$optional" "--save-optional"
