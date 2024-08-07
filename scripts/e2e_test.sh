#!/bin/bash
set -ex

log() {
  echo -e "\n>>>>> $1\n"
}

####################################################################################################

# This list should be extended as more demos are written!
directories=(
  bank/bank-backend
  # bank/bank-frontend

  e-commerce/payment-backend
  e-commerce/shop-backend
  e-commerce/shop-frontend

  greeting-guestbook
  shop-guide
  tpcc
  widget-fulfillment
  widget-store
  yky-social
)

demo_apps_dir="dbos-demo-apps"

orig_dir="$PWD"
all_lints_succeeded=true

plugin_version=$(jq -r '.version' package.json)
tarball_name="dbos-inc-eslint-plugin-$plugin_version.tgz"
tarball_path="$orig_dir/$tarball_name"

####################################################################################################

prepare_demo_apps_dir() {
  if [[ -d "$demo_apps_dir" ]]; then
    # This is here so that running the test locally won't involve a re-clone
    cd "$demo_apps_dir"
    git restore . # Removing any changes made
    git pull # Pulling the latest changes
    cd ..
  else
    git clone "https://github.com/dbos-inc/$demo_apps_dir"
  fi
}

npm run build
npm pack
prepare_demo_apps_dir

for directory in "${directories[@]}"; do
  log "Begin linting of '$directory'"

  cd "$demo_apps_dir/$directory"
  cp "$tarball_path" .

  npm remove @dbos-inc/eslint-plugin # First, remove the old version
  npm install "$tarball_name" --save-dev # Then, install the new one

  # Turning off error checking temporarily
  set +e
  npm run lint
  lint_result="$?"
  set -e

  if [[ "$lint_result" -ne 0 ]]; then
    all_lints_succeeded=false
  fi

  log "Exit code for linting '$directory': $lint_result"

  cd "$orig_dir"
done

log "Finished the e2e test"

if [[ "$all_lints_succeeded" = false ]]; then
  exit 1
fi

####################################################################################################
