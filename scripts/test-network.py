#!/usr/bin/env python3
"""Live network checks. Run inside fc after setup-host.sh and host build."""
import concurrent.futures
import json
from pathlib import Path
import socket
import subprocess
import time

ROOT = Path(__file__).resolve().parent.parent
CLI = ["node", str(ROOT / "host/dist/cli.js"), "exec", "--timeout", "25", "--"]


def execute(code, timeout=45):
    result = subprocess.run(CLI + [code], text=True, capture_output=True, timeout=timeout)
    assert result.returncode == 0, result.stderr
    return result.stdout


def namespaces():
    return {line.split()[0] for line in subprocess.check_output(["ip", "netns", "list"], text=True).splitlines()}


def check_ingress():
    before = namespaces()
    # Verify that a server was listening in the guest while we tried ingress.
    code = 'const s=require("net").createServer(c=>c.end("unexpected")); s.listen(3000,"0.0.0.0",()=>console.log("listening")); setTimeout(()=>s.close(),5000)'
    process = subprocess.Popen(CLI + [code], text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    namespace = None
    route_added = False
    try:
        deadline = time.monotonic() + 8
        while time.monotonic() < deadline:
            added = namespaces() - before
            if added:
                candidate = next(iter(added))
                if subprocess.run(["sudo", "ip", "-n", candidate, "link", "show", "tap0"], capture_output=True).returncode == 0:
                    namespace = candidate
                    break
            time.sleep(0.05)
        assert namespace, "No test namespace appeared"
        identifier = namespace.removeprefix("as-")
        lease = json.loads(subprocess.check_output(["sudo", "cat", f"/run/agent-sandbox-network/{identifier}"], text=True))
        # A test-only host route lets us reach the guest subnet directly. The
        # namespace firewall must still reject this unsolicited connection.
        subprocess.run(["sudo", "ip", "route", "add", "172.30.0.2/32", "via", lease["ip"], "dev", "asv" + identifier], check=True)
        route_added = True
        time.sleep(1.5)
        try:
            with socket.create_connection(("172.30.0.2", 3000), timeout=0.6):
                raise AssertionError("Unsolicited ingress reached the guest")
        except (TimeoutError, ConnectionRefusedError, OSError):
            pass
        rules = json.loads(subprocess.check_output(["sudo", "ip", "netns", "exec", namespace, "nft", "-j", "list", "chain", "inet", "sandbox", "forward"], text=True))
        dropped = sum(expr["counter"]["packets"] for item in rules["nftables"] if "rule" in item
                      for expr in item["rule"]["expr"] if "counter" in expr
                      and any("drop" in e for e in item["rule"]["expr"]))
        assert dropped > 0, "No firewall drop was recorded"
        out, err = process.communicate(timeout=12)
        assert process.returncode == 0 and out == "listening\n", (out, err)
    finally:
        if route_added:
            # Removing the VM's veth also removes routes through it, so the
            # normal sandbox cleanup may already have removed this test route.
            subprocess.run(["sudo", "ip", "route", "del", "172.30.0.2/32"], check=False, capture_output=True)
        if process.poll() is None:
            process.wait(timeout=30)
    assert namespaces() == before, "Namespace leaked after execution"


def main():
    before = namespaces()
    out = execute('''(async()=>{
      const response=await fetch("https://example.com",{signal:AbortSignal.timeout(10000)});
      if(response.status!==200) throw Error("HTTPS failed");
      console.log("https ok");
      for(const url of ["https://10.0.0.1","https://169.254.169.254","https://192.168.5.2","http://example.com","https://[2606:4700:4700::1111]"]){
        let blocked=false;
        try{await fetch(url,{signal:AbortSignal.timeout(600)})}catch{blocked=true}
        if(!blocked)throw Error("Unexpected access: "+url);
      }
      console.log("blocked destinations ok");
    })().catch(e=>{console.error(e);process.exitCode=1})''')
    assert out == "https ok\nblocked destinations ok\n", out
    print(out, end="", flush=True)
    code = '(async()=>{const response=await fetch("https://example.com",{signal:AbortSignal.timeout(10000)});if(response.status!==200)throw Error("concurrent HTTPS failed");console.log(JSON.stringify({crypto:require("crypto").randomBytes(32).toString("hex"),math:Math.random()}))})().catch(e=>{console.error(e);process.exitCode=1})'
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
        values = list(pool.map(lambda _: json.loads(execute(code)), range(2)))
    assert values[0]["crypto"] != values[1]["crypto"], "Cloned crypto RNG state"
    assert values[0]["math"] != values[1]["math"], "Cloned Math.random state"
    assert namespaces() == before, "Concurrent execution leaked a namespace"
    print("concurrency and reseeding ok", flush=True)
    check_ingress()
    print("unsolicited ingress blocked; cleanup ok", flush=True)
    timeout = subprocess.run(CLI[:4] + ["1", "--", "setInterval(()=>{},1000)"], text=True, capture_output=True, timeout=10)
    assert timeout.returncode == 124, timeout.stderr
    assert namespaces() == before, "Timeout leaked a namespace"
    print("timeout cleanup ok", flush=True)


if __name__ == "__main__":
    main()
