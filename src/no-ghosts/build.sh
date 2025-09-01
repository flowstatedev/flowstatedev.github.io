#!/usr/bin/env bash
set -e

rm -rf dist
mkdir dist
touch dist/_THIS_FOLDER_IS_AUTO_GENERATED_AND_AUTO_DELETED

npx webpack

# don't do this as it breaks local web servers (for example)
# rm -rf ../../docs/no-ghosts

pushd ../../docs >& /dev/null
mkdir -p no-ghosts
cd no-ghosts && rm -rf -- ..?* .[!.]* *
popd >& /dev/null
cp -Rf dist/* ../../docs/no-ghosts/
git add ../../docs/no-ghosts
