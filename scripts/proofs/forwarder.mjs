/**
 * Root-run TCP forwarder. Used only by the runtime proofs so that engine
 * simulators (bound to unprivileged ports by a normal user) can be reached at
 * the portless https?://<slug>.trycloudflare.com URLs that resolve.ts's
 * LIVE_LINK_RE actually matches.
 *
 * usage: node forwarder.mjs <listenHost> <listenPort> <targetPort>
 */
import net from "node:net";

const [, , listenHost, listenPort, targetPort] = process.argv;

const server = net.createServer((client) => {
  const upstream = net.connect(Number(targetPort), "127.0.0.1");
  client.pipe(upstream);
  upstream.pipe(client);
  const kill = () => {
    client.destroy();
    upstream.destroy();
  };
  client.on("error", kill);
  upstream.on("error", kill);
});

server.listen(Number(listenPort), listenHost, () => {
  process.stdout.write(`READY ${listenHost}:${listenPort} -> 127.0.0.1:${targetPort}\n`);
});
