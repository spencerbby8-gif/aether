#!/usr/bin/env bash
# Compile every JVM proof against the real app sources and run the ones that
# need no live engine. These exercise EngineCore's parser, ChatMessage's
# storage, AgentActivity's event mapping and the executor wiring -- the parts
# that cannot be observed on a device from here.
#
# Live-network proofs (ChatLifecycleProof, ContextProof, EngineAudit,
# FailoverProof, LiveStreamProof, MultiEngineProof, MultiInstanceProof,
# ShutdownProof) are deliberately excluded: they need a running Kaggle engine
# and would report failure on a quiet morning. Run them when one is up.
#
# FailoverProof is the one to run after any routing change. It exercises
# discovery, classify and route against real tunnels, and is most informative
# when one of them is genuinely dead -- which is the failure users actually
# hit, since quick tunnels die under a running kernel while Kaggle still
# reports the kernel as running.
#
# Usage: bash scripts/proofs/jvm-suite.sh
set -u

REPO="$(cd "$(dirname "$0")/../.." && pwd)"
T="${TOOLCHAIN:-$HOME/.cache/toolchain}"
JSON_JAR="$T/jars/json-20240303.jar"
OUT=/tmp/jvm-suite
export JAVA_HOME="$T/jdk"
export PATH="$T/jdk/bin:$PATH"

if [ ! -f "$JSON_JAR" ]; then
  echo "missing $JSON_JAR -- run scripts/setup-android-toolchain.sh first"
  exit 2
fi

rm -rf "$OUT"
mkdir -p "$OUT"

# Only the pure-Java layer. The Activity classes need the Android SDK and are
# covered by gradle :app:compileDebugJavaWithJavac instead.
SRC="$REPO/android/app/src/main/java/com/aether/app"
javac -encoding UTF-8 -nowarn -cp "$JSON_JAR" -d "$OUT" \
  "$SRC/EngineCore.java" "$SRC/EngineRouter.java" \
  $(find "$SRC/core" -name '*.java') \
  $(find "$REPO/scripts/proofs" -name '*.java') 2>&1 | grep -E "error:" && {
    echo "COMPILE FAILED"; exit 1; }

FIXTURE="$REPO/scripts/proofs/output/real-agent-events.ndjson"

# proof name, extra args
PROOFS=(
  "StreamProof"
  "MediaStreamProof"
  "StreamTimeoutProof"
  "ExecutorProof"
  "ChatCoreCheck"
  "RouterCheck"
  "AnswerBlocksCheck"
  "AgentActivityCheck|$FIXTURE"
  "StatusProof|$REPO/android/credentials.properties $REPO/android/app/src/main/assets/aether-notebook-template.json"
  "PushRefusalProof|"
  "EngineLabelsProof|"
)

fails=0
for entry in "${PROOFS[@]}"; do
  name="${entry%%|*}"
  args="${entry#*|}"
  [ "$args" = "$entry" ] && args=""
  if [ ! -f "$OUT/$name.class" ]; then
    printf "  SKIP  %-22s no class produced\n" "$name"
    continue
  fi
  out=$(java -cp "$OUT:$JSON_JAR" "$name" $args 2>&1)
  rc=$?
  tally=$(echo "$out" | grep -E "[0-9]+ passed, [0-9]+ failed" | tail -1)
  [ -z "$tally" ] && tally="(no tally printed)"
  if [ $rc -eq 0 ]; then
    printf "  ok    %-22s %s\n" "$name" "$tally"
  else
    printf "  FAIL  %-22s %s\n" "$name" "$tally"
    echo "$out" | grep -E "FAIL" | head -5 | sed 's/^/          /'
    fails=$((fails + 1))
  fi
done

echo
echo "JVM SUITE  $(( ${#PROOFS[@]} - fails ))/${#PROOFS[@]} proofs clean"
exit $(( fails > 0 ? 1 : 0 ))
