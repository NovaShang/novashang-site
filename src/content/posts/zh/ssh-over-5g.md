---
title: "只在 5G 下失败的 SSH 连接"
description: "iPhone 通过 Tailscale 发起的 SSH 连接在 5G 下 30 秒超时、线路上不见一个包，最后发现是 iOS 把 IPv4 字面地址合成成了 NAT64 地址。"
pubDate: 2026-07-31
tags: ["技术", "网络", "iOS", "SSH", "Tailscale"]
lang: zh
---

*一个 30 秒超时、线路上一个包都看不到的问题，最后查出来是操作系统好心替我们改写了地址。*

[Bento Term](https://bentoai.dev/term) 用普通的 SSH 把 iPhone 连到 Mac 上。Mac 在家里的路由器后面，手机通过 Tailscale 访问它。在 Wi-Fi 下一连就通；在 5G 下却会一直转圈，然后失败。不是每次都这样，但频繁到足以让它没法用。

结果这个 bug 和 SSH、tmux、超时设置都没有关系，和我一度确信的那四个原因也全都无关。下面是完整的复盘，包括走过的弯路，因为弯路才是最有意思的部分。

## 症状

App 报的是 `Connect timeout (30 s)`，除此之外什么都没有。每次失败看起来都一模一样。

遇到连接超时，第一件值得弄清楚的事是：包到底停在了*哪里*。在 Mac 上，`last` 和 `sshd` 的统一日志（unified log）显示，当天早些时候有来自手机 tailnet 地址的成功登录；但在失败的那几次尝试里，什么都没有。没有派生 `sshd` 进程，没有半开连接，没有任何痕迹。SYN 包根本没有到达。

与此同时，隧道本身是健康的。在 Mac 上：

```
$ tailscale ping my-iphone
pong from my-iphone (100.64.0.20) via DERP(lax) in 160ms
...
direct connection not established
```

流量走的是 DERP 中继（Mac 在对称型 NAT 后面，手机在运营商的 CGNAT 后面，不可能建立直连），但是通的，双向都通，延迟在 60 到 900 ms 之间。

## 四次走错路

在拿到任何设备端日志之前，我只凭 Mac 这一侧能看到的东西搭了一套理论。每一步都说得通，每一步也都是错的。按顺序来：

**"是握手超时。"** Citadel（我们用的 Swift SSH 客户端）把登录超时硬编码成了 10 秒，公开 API 里改不了。一次 SSH 握手要六到八个往返；按 900 ms 的 RTT 算就是 5 到 7 秒，稍有抖动就会超时。理论很漂亮。可日志写的是 `Connect timeout (30 s)`，30 秒是 *TCP* 引导（bootstrap）阶段的超时，不是那个 10 秒的登录超时。握手压根就没开始。

**"是会话发现的超时。"** iOS 上的会话选择器会单独再开一条 SSH 连接，只为了跑一下 `tmux ls`：先固定等 500 ms 让 shell 稳定下来，再给这条命令 5 秒。在中继链路上这点预算很勉强，而且一旦超时它会悄悄返回一个空列表。这是个真问题，我也找到并验证了它；但它发生在连接*建立之后*，而我们连连接都没建起来。

**"是三条多余的 SSH 连接。"** 每次 attach 都会开三条连接：选择器的发现连接、真正的那条连接，以及之后选择器又开的一条。三次冷启动握手，等于把每条连接上任何可能的失败概率放大了三倍。这也是真问题，但也不是这次的原因。

**"BSD socket 在蜂窝网络下没法走 VPN。"** 在 Bento 连不上的那些时刻，Safari、Termius 和 Tailscale 自己的 App 都能从手机访问到 Mac。它们用的是 Network.framework，而 SwiftNIO 用的是普通的 BSD socket。故事自己就编圆了。

最后这个理论离真相近到了危险的程度，所以我不再空想，开始在 App 里加探针。

## 探针

四个问题，在 App 内部、在一次真实失败的连接发生的那一刻回答：

1. 系统认为当前的网络路径是什么样的？
2. Network.framework 能连到对端吗？
3. 一个裸的 BSD socket（我们自己的，不是 NIO 的）能连到吗？
4. 如果把源地址绑定到隧道的地址上，BSD socket 能连到吗？

在 5G 下跑一次的结果：

```
path: status=satisfied v4=false v6=true expensive=true ifaces=[pdp_ip0:cellular,utun8:other]
ifaces: ... pdp_ip0/v4=192.0.0.2 ... utun8/v4=100.64.0.20 utun8/v6=fd7a:115c:a1e0::20

Network.framework      -> 100.64.0.10:22: ok in 180ms
BSD socket             -> 100.64.0.10:22: ok in 70ms
BSD socket bound to utun8 -> 100.64.0.10:22: ok in 61ms
SSH connection error after 30031ms: Connect timeout (30 s)
```

同一个 App、同一秒钟里，一个普通的 BSD socket 只用了 **70 毫秒**就连上了，而 NIO 却在 30 秒后超时。socket API 的理论就此破产。问题出在 socket 之上的某一层。

这段输出里有两点后面会用到。一是 `path: v4=false`：运营商网络是纯 IPv6 的，`pdp_ip0` 上的 `192.0.0.2` 是 464XLAT 的转换地址，不是真正的 IPv4 地址。二是我的探针是用 `inet_pton` 直接解析地址字面量去连对端的，**完全没有经过 DNS**。而 NIO 接收的是一个 `String`。

## 答案

再加两个探针。第一个，完全按照 NIO 的解析器的方式去解析这个地址：同样的 hints，不带 `AI_NUMERICHOST`。第二个，并排跑两次 NIO 连接：一次传主机名字符串，一次传预先解析好的 `SocketAddress`。

```
getaddrinfo("100.64.0.10")     -> v6:2001:db8:0:a:0:2:6440:a
NIO connect(host:)             -> failed after 10022ms: Connect timeout
NIO connect(to: SocketAddress) -> ok in 76ms
```

我们要的是一个 IPv4 地址，系统给的却是一个 IPv6 地址。

看最后 32 位：`6440:a`，也就是 `6440:000a`，即 `0x64 0x40 0x00 0x0a` = **100.64.0.10**。这正是我们的地址，原封不动地嵌在运营商的 NAT64 前缀 `2001:db8:0:a:0:2::/96` 后面。`getaddrinfo` *只*返回了这一个地址，一个 IPv4 都没有，于是 Happy Eyeballs 只有一个候选，而且是错的那个。

这是 Apple 有文档说明、有意为之的行为。在带 NAT64/DNS64 的纯 IPv6 网络上，`getaddrinfo` 会根据 IPv4 *字面量*合成一个 IPv6 地址，好让那些把 IPv4 地址写死在代码里的 App 继续工作：包会发往运营商的 NAT64 网关，由网关在另一侧再转换回 IPv4。对公网地址来说，这样做完全正确。

但对一个只存在于 VPN 内部的地址来说，这是致命的。`100.64.0.0/10` 是 Tailscale 分配地址所用的 CGNAT 网段，只在隧道内部可路由，出了隧道哪儿都到不了。合成出来的地址让我们的连接经由运营商网关发出，奔向一个公网根本无法到达的目的地。包石沉大海。而那条隧道明明已经建立、状态健康、延迟只有 60 ms，却从来没被用上。

Wi-Fi 是双栈的，没有 DNS64，所以不会合成地址，所以一直正常。Safari 和 Termius 从来不会把 IP 字面量交给解析器。所有观察到的现象都对上了。

而 NIO 从来不会对字面量走捷径：`ClientBootstrap.connect(host:port:)` 会构造一个 `GetaddrinfoResolver`，把字符串原样交给它，不管这个字符串是什么。

## 修复，以及没成功的那个修复

最正当的修复是彻底跳过解析：把字面量解析成 `SocketAddress`，直接连它。Citadel 甚至为此提供了入口：`SSHClient.connect(on:)` 接受一个你自己建好的 channel。

结果它崩了：

```
NIOCore/ChannelPipeline.swift:1208: Precondition failed
```

`connect(on:)` 用 `pipeline.syncOperations` 安装它的 handler，这要求调用方必须在该 channel 的 event loop 上。在 Citadel 的常规路径里，这段代码运行在 bootstrap 的 `channelInitializer` 里，满足这个条件。而 `connect(on:)` 是从调用方的 `async` 上下文里直接调用它的，不满足。这个文档里写明的"逃生通道"在 Swift 并发下根本没法用，大概这也是为什么没有任何测试覆盖它。

于是我们绕过去。`::ffff:100.64.0.10` 是同一个地址的 IPv4 映射形式（IPv4-mapped）。它*本身*就已经是一个 IPv6 字面量，所以 `getaddrinfo` 没有什么可合成的，会原样返回；而内核会把它当作 IPv4 来路由，直接送进隧道。整个修复只有四行：

```swift
private static func connectAddress(for hostname: String) -> String {
    guard let parsed = try? SocketAddress(ipAddress: hostname, port: 0),
          case .v4 = parsed else { return hostname }
    return "::ffff:" + hostname
}
```

主机名则原样放行：对主机名来说，解析器是在正常履行职责，为真实域名合成地址是正确的。

这次排查顺带挖出了 Citadel 的四个 bug，都已写好说明和补丁，准备提交给上游：字面量地址会经过解析器；一个便捷重载会悄悄丢掉它的三个参数；`connect(on:)` 在认证完成之前就返回；以及上面那个 event loop 陷阱。

## 如果重来一次

**超时不是诊断结论。** "Connect timeout (30 s)" 和 "Connect timeout (10 s)" 来自两个不同的子系统，含义完全不同。我在一个早已被这两个数字排除掉的理论上花了一个小时。

**本地化的错误信息会销毁证据。** 原来的代码记录的是 `error.localizedDescription`，对 NIO 和 Citadel 的错误来说，不管什么原因，它都是同一句毫无信息量的话。换成 `String(reflecting:)` 之后，第一份日志才变得可读。

**对照探针胜过理论。** 我从服务端出发形成的每一个理论都是错的。真正找到 bug 的办法，是在同一个进程里、同一秒钟内，对同一个地址发起四次连接，每次只改变一个变量。决定性的证据只有两行：一个 API 超时，另一个 76 ms 就成功了。

**你怀疑的那一层，很少是说谎的那一层。** 我先怀疑 SSH，然后是 tmux，然后是 socket API。结果是名字解析器在作怪，而那个地址从一开始就不是一个名字。
