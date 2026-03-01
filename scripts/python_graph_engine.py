#!/usr/bin/env python3
import argparse
import json
from collections import defaultdict, deque


def build_graph(payload):
    nodes = []
    edges = []

    for domain in payload.get("domains", []):
        nodes.append((f"domain:{domain}", "Domain"))
    for url in payload.get("urls", []):
        nodes.append((f"url:{url}", "URL"))
    for ip in payload.get("ips", []):
        nodes.append((f"ip:{ip}", "IP"))
    for email in payload.get("emails", []):
        nodes.append((f"email:{email}", "Email"))
    for username in payload.get("usernames", []):
        nodes.append((f"username:{username}", "Username"))
    for cert in payload.get("certs", []):
        nodes.append((f"cert:{cert}", "Cert"))

    for domain in payload.get("domains", []):
        for ip in payload.get("ips", []):
            edges.append((f"domain:{domain}", f"ip:{ip}"))

    for email in payload.get("emails", []):
        if "@" in email:
            domain = email.split("@", 1)[1]
            edges.append((f"email:{email}", f"domain:{domain}"))

    for username in payload.get("usernames", []):
        for email in payload.get("emails", []):
            if email.startswith(username):
                edges.append((f"username:{username}", f"email:{email}"))

    return nodes, edges


def centrality(nodes, edges):
    index = {node_id: i for i, (node_id, _) in enumerate(nodes)}
    degree = defaultdict(int)
    for src, dst in edges:
        degree[src] += 1
        degree[dst] += 1

    denom = max(1, len(nodes) - 1)
    return {node_id: round(degree[node_id] / denom, 4) for node_id, _ in nodes}


def connected_components(nodes, edges):
    adjacency = defaultdict(set)
    for src, dst in edges:
        adjacency[src].add(dst)
        adjacency[dst].add(src)

    seen = set()
    count = 0
    for node_id, _ in nodes:
        if node_id in seen:
            continue
        count += 1
        queue = deque([node_id])
        while queue:
            cur = queue.popleft()
            if cur in seen:
                continue
            seen.add(cur)
            for nxt in adjacency[cur]:
                if nxt not in seen:
                    queue.append(nxt)
    return count


def correlation_strength(edges):
    strength = []
    for src, dst in edges:
        weight = 0.6
        if src.startswith("email:") and dst.startswith("domain:"):
            weight = 0.95
        elif src.startswith("domain:") and dst.startswith("ip:"):
            weight = 0.8
        elif src.startswith("username:"):
            weight = 0.7
        strength.append({"source": src, "target": dst, "strength": weight})
    return strength


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()

    with open(args.input, "r", encoding="utf-8") as f:
      payload = json.load(f)

    nodes, edges = build_graph(payload)
    result = {
        "metrics": {
            "node_count": len(nodes),
            "edge_count": len(edges),
            "components": connected_components(nodes, edges),
            "centrality": centrality(nodes, edges),
        },
        "correlation_strength": correlation_strength(edges),
    }

    with open(args.output, "w", encoding="utf-8") as f:
        json.dump(result, f, indent=2)


if __name__ == "__main__":
    main()
