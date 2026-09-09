# Source this after scripts/setup-browser-libs.sh.
# Chromium needs libraries that are absent from the sandbox image; the setup
# script unpacks them into a private prefix that requires no root.
export CRLIBS_DIR="${CRLIBS_DIR:-/home/user/.cache/crlibs}"
export LD_LIBRARY_PATH="$CRLIBS_DIR/usr/lib/x86_64-linux-gnu${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
