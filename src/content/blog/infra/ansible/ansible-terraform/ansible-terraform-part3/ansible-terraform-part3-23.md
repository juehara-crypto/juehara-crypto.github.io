---
title: '「AnsibleとTerraformの連携が壊れる理由はライフサイクルにあった」 第23回：大容量ファイル転送・重いタスク実行時におけるSSHタイムアウト'
description: '大容量ファイル転送や重いタスク実行時にTerraform側のプロビジョナータイムアウトへ抵触する構造を、接続確立時と転送中無応答というSSHタイムアウトの発生層、TCP輻輳制御・MTU等のネットワーク層の要因に分けて整理する。タイムアウト値の調整・処理分割による対処もあわせて扱う。'
pubDate: '2026-08-25'
category: 'infra'
tags: ['Ansible', 'Terraform', 'SSH', 'タイムアウト', 'ネットワーク']
seriesId: 'ansible-terraform-part3'
seriesNo: 23
prevPost: 'https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part3/ansible-terraform-part3-22/'
nextPost: 'https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part3/ansible-terraform-part3-24/'
relatedSeries: ''
---

<style> table th, table td { word-break: normal; } table td:first-child { white-space: nowrap; } </style>

> **🗺️ 初めての方、シリーズの全体像を知りたい方はこちら**
> 
> シリーズ全体については、以下のまとめブログで整理しています。
> 
> → **「AnsibleとTerraformの連携が壊れる理由はライフサイクルにあった」シリーズ統合ブログ** **※近日公開予定**

---

## 📋 目次

1. [はじめに](#1-はじめに)
2. [SSHタイムアウトの発生層を分ける](#2-sshタイムアウトの発生層を分ける)
3. [TCP輻輳制御とウィンドウサイズの自動調整](#3-tcp輻輳制御とウィンドウサイズの自動調整)
4. [MTU・フラグメンテーションの影響](#4-mtuフラグメンテーションの影響)
5. [Terraform側プロビジョナーとAnsible側、双方のタイムアウト設計](#5-terraform側プロビジョナーとansible側双方のタイムアウト設計)
6. [Ansible側での対処](#6-ansible側での対処)
7. [まとめ](#7-まとめ)
8. [次回予告](#8-次回予告)
9. [連載一覧：「AnsibleとTerraformの連携が壊れる理由はライフサイクルにあった」](#9-連載一覧ansibleとterraformの連携が壊れる理由はライフサイクルにあった)

---

### 1. はじめに

「SSHタイムアウトが起きるのは、ネットワークが遅いからだ」と考えたことはないでしょうか。

**[第22回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part3/ansible-terraform-part3-22/)** では、複数のDockerネットワークをアタッチした際に、HCL上の記述順序とコンテナ内部でのインターフェース割り当てが一致しない構造を扱いました。パケットがどの経路を通るか、そしてその経路がAnsibleの接続先IP自動検出にどう波及するかという、到達性そのものの問題でした。

第23回では、経路自体は正しく到達している前提に立ちます。その上で、大容量のファイルを転送したり、重いタスクを実行したりする際に発生する、速度と継続性に関する問題を扱います。**[第21回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part3/ansible-terraform-part3-21/)** のログ解析、第22回のインターフェース確認に続く、ネットワーク起因トラブルの3回目という位置づけになります。

SSHのタイムアウトという現象一つを取っても、その背景にはTCPの輻輳制御やウィンドウサイズの自動調整、SSH側の接続維持設定、MTUに起因するフラグメンテーションなど、複数の要因が絡んでいます。この回で扱う問いは、「転送量や処理時間が既定のタイムアウト値を超えるとき、実際にどの層で何が起きているのか」です。

次のセクションでは、この問いの前提となる、SSHタイムアウトそのものが持つ発生層の違いを整理します。

---

[↑ 目次に戻る](#-目次)

---

## 2. SSHタイムアウトの発生層を分ける

この回の前提となる「タイムアウトの種類」を整理します。SSHのタイムアウトは一つの現象ではなく、発生するタイミングによって原因も設定項目も異なります。

```
【接続確立時のタイムアウト】
TCPコネクション自体が確立できない
　→ ConnectTimeout（SSHクライアント側の設定）が関係する
　→ 到達性、ポート開放が主な原因

【転送中の無応答によるタイムアウト】
接続は確立しているが、データ転送中に応答が途絶える
　→ ServerAliveInterval / ServerAliveCountMax が関係する
　→ 転送量、処理時間が既定のタイムアウト値を超えることが主な原因
```

前者の`ConnectTimeout`は、SSHクライアントがTCPの3ウェイハンドシェイクを試みてから、応答を待つ上限時間です。この段階で失敗する場合、原因は宛先IPやポートが到達可能かどうか、SSHDが起動しているかどうかといった、接続そのものが成立するかという話に閉じています。**[第22回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part3/ansible-terraform-part3-22/)** で扱った、意図しないインターフェースへ接続してしまう問題はこちらに近い性質を持ちます。

一方、後者の`ServerAliveInterval`と`ServerAliveCountMax`は、いったん確立した接続の上で、サーバー側からの応答がどれだけ途絶えたら切断するかという設定です。大容量ファイルの転送や重いタスクの実行中に発生するタイムアウトは、接続自体は成立した後の話であるため、こちらの層に属します。

第23回で扱うのは後者、つまり転送中の無応答によるタイムアウトです。**[第22回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part3/ansible-terraform-part3-22/)** で扱った到達性の問題とは、同じ「SSH接続がうまくいかない」という結果であっても、発生している層が異なります。この違いを前提に、次のセクションからは、転送中の無応答がなぜ起きるのかという要因を、TCP層、MTU層と順に見ていきます。

---

[↑ 目次に戻る](#-目次)

---

## 3. TCP輻輳制御とウィンドウサイズの自動調整

「転送量が多いとタイムアウトする」という理解に、ここでいったんブレーキをかけます。現代のLinuxカーネルは、TCPの送受信バッファサイズや輻輳ウィンドウを通信状況に応じて自動的にチューニングする仕組みを標準で備えています。

```
net.ipv4.tcp_moderate_rcvbuf = 1（デフォルト）
```

この値が1の場合、受信バッファサイズはカーネルが通信状況に応じて自動調整します。かつては`net.core.rmem_max`や`net.core.wmem_max`といったパラメータを手動でチューニングする作業が一般的でしたが、現在はこの自動調整により、単純な帯域不足だけでは以前ほど極端な性能劣化が起きにくくなっています。

コンテナはホストのカーネルを共有しているため、この自動チューニングの仕組み自体はホスト側のカーネル設定がそのまま反映されます。Dockerコンテナ内で通信するAnsibleのSSHセッションも、この自動調整の恩恵をそのまま受けます。

ただし、自動調整はあくまで帯域や遅延の変化に対してウィンドウサイズを最適化する仕組みであり、転送そのものにかかる時間を短縮するものではありません。回線が細ければ細いなりに、遅延が大きければ大きいなりに調整されるだけで、既定のタイムアウト値との関係でいえば、転送量や処理時間がその値を構造的に超えてしまうリスク自体は残ります。「輻輳制御が賢くなったからタイムアウトは起きにくい」という理解は半分正しく、半分は誤りです。TCP層の自動調整は接続の効率を高めますが、タイムアウト値という固定の上限そのものを引き上げてくれるわけではありません。

このセクションは概念説明として構成しており、実機での挙動確認は行いません。次のセクションでは、この自動調整でも吸収しきれない、MTUとフラグメンテーションという別の要因を整理します。

---

[↑ 目次に戻る](#-目次)

---

## 4. MTU・フラグメンテーションの影響

前セクションで整理したTCPの自動調整でも吸収しきれない要因として、MTUとフラグメンテーションを整理します。

VPN等のトンネリングを経由する通信では、トンネリングのオーバーヘッド分だけ実効MTUが小さくなります。DockerのブリッジネットワークやoverlayネットワークにもMTUの差異があり、コンテナ間通信であっても、ホストの物理NICや仮想NICのMTU設定に影響されます。

```
通常のイーサネット：MTU 1500
VPNトンネル経由：MTU 1400前後（トンネリングのヘッダ分だけ縮小）
Dockerのoverlayネットワーク経由：VXLANのヘッダ分だけ縮小するケースがある
```

送信側がこの縮小を考慮せず、経路上の実効MTUより大きいパケットを送出すると、経路上でフラグメント化されます。フラグメント化されたパケットの一部が失われると、TCP側での再送が発生します。この再送が積み重なることで、転送全体が遅延し、あるいは停止しているように見える構造につながります。単発のパケットロスであれば再送で吸収できますが、フラグメント化されたパケットは元より失われやすく、再送の頻度が上がるほど、実効的なスループットは低下していきます。大容量ファイルの転送中に発生する「進んでいるのか止まっているのか分からない」という体感は、この再送の積み重ねが背景にあることが少なくありません。

実効MTUを特定する手法として、`ping -M do -s <サイズ>`でDFビット（Don't Fragment）を立てた状態でパケットサイズを変えながら送信し、どのサイズから失敗するかを確認する方法があります。この手法自体は紹介にとどめ、この回では実機での実演は行いません。

ここまでのセクションで、TCPの自動調整があってもタイムアウトのリスクが残ること、そしてMTU・フラグメンテーションが遅延やパケットロスの原因になりうることを整理しました。次のセクションでは、これらのネットワーク層の要因を踏まえた上で、TerraformとAnsibleそれぞれが持つタイムアウト設定そのものに視点を移します。

---

[↑ 目次に戻る](#-目次)

---

## 5. Terraform側プロビジョナーとAnsible側、双方のタイムアウト設計

ここまでのセクションで、SSHタイムアウトの発生層と、その背景にあるネットワーク層の要因を整理しました。このセクションでは、この回の核心にあたる、TerraformとAnsibleそれぞれが独立して持つタイムアウト設定の構造を整理します。

Terraformのプロビジョナー（`local-exec`、`remote-exec`）には、それ自体のタイムアウト設定があります。これとは別に、Ansible側にも接続維持設定（`ServerAliveInterval`、`timeout`等）が存在します。両者は別々の仕組みであり、片方を意識するだけでは不十分です。

```
【Terraform側】
provisioner "local-exec" {
  command = "ansible-playbook -i inventory.ini site.yml"
  # タイムアウトを明示しない場合、外側のCI/CD等のタイムアウトに依存する
}

【Ansible側】
ansible_ssh_common_args: '-o ServerAliveInterval=15 -o ServerAliveCountMax=3'
timeout: 30
```

`local-exec`自体には、明示的なタイムアウトを設定しない限り、プロセスの終了を無期限に待ち続けるという性質があります。この場合、実際に処理を打ち切るのは、CI/CDパイプライン側のジョブタイムアウトや、シェル自体のタイムアウトといった、Terraformの外側にある仕組みであることが多くなります。一方Ansible側は、`ansible_ssh_common_args`で指定した`ServerAliveInterval`が、SSHセッションの無応答をどれだけ許容するかを制御します。

この2つは、それぞれが別の層で、別の基準に基づいてタイムアウトを判定しています。Terraform側は「プロセス全体がいつまでに終わるか」を見ており、Ansible側は「SSHセッションがいつまで無応答を許容するか」を見ています。転送量や処理量があらかじめ見積もれる場合、この両者のタイムアウト設定を、その転送量に応じてそれぞれ調整しておく必要があります。片方だけを緩めても、もう片方が先に切断してしまえば、全体としてはタイムアウトのまま失敗します。逆に、Ansible側だけを緩めても、Terraform側やその外側のCI/CDのタイムアウトが先に発火すれば、同じく失敗に終わります。

つまり、大容量ファイル転送や重いタスクへの対処は、どちらか一方の設定を調整すれば済むものではなく、両者が独立した仕組みであることを踏まえた上で、揃えて見積もる必要がある構造だといえます。次のセクションでは、この構造を踏まえた上で、実務でよく使われるAnsible側の対処パターンを整理します。

---

[↑ 目次に戻る](#-目次)

---

## 6. Ansible側での対処

前セクションで整理した通り、TerraformとAnsibleのタイムアウト設定は独立しており、双方を転送量に応じて見積もる必要があります。このセクションでは、実務での対処パターンをAnsible側の観点から整理します。

```
【SSHの接続維持設定】
ansible_ssh_common_args で ServerAliveInterval・ConnectTimeout を明示的に設定する

【転送方式の見直し】
copyモジュール（SCP相当）ではなく、synchronizeモジュール（rsyncベース）を使う
→ 差分転送・再開性の点で大容量ファイルに向いている

【処理の分割】
大容量データの転送・重いタスクを複数の小さなタスクに分割する
→ 個々のタスクの処理時間を短縮し、単一タスクでのタイムアウト超過リスクを下げる

【SSH多重化】
ansible_ssh_pipelining を有効にし、SSH接続の確立回数自体を減らす
```

それぞれの対処が、どの層に効くのかを対応させて整理します。

`ServerAliveInterval`の明示的な設定は、**第2節**で整理した「転送中の無応答によるタイムアウト」そのものに効きます。デフォルト値のまま運用していると、環境によっては意図しないタイミングで切断されることがあるため、転送量に応じた値を明示しておくことが対処の起点になります。

転送方式の見直しは、**第3節・第4節**で整理したネットワーク層の要因、特にパケットロスや再送の積み重ねに対して効果があります。`copy`モジュールが内部で使うSCP相当の転送は、一度失敗すると最初からやり直しになりやすい一方、`synchronize`モジュールが使うrsyncは差分転送と再開性を備えているため、途中でパケットロスが発生しても、全体の転送時間への影響を抑えやすくなります。

処理の分割は、**第5節**で整理したタイムアウト設計そのものへの対処です。個々のタスクが扱うデータ量、処理時間を小さく保つことで、単一タスクがタイムアウト値を超えるリスクそのものを下げます。Terraform側、Ansible側のどちらのタイムアウト設定も、値を大きく引き上げるより、そもそも単一の処理が長時間化しない設計にする方が、見積もりの精度という点でも扱いやすくなります。

`ansible_ssh_pipelining`の有効化は、SSH接続の確立回数自体を減らすことで、**第2節**で整理した接続確立時のオーバーヘッドを削減します。転送中の無応答そのものへの直接的な対処ではありませんが、タスク数が多い場合には、接続確立の積み重なりが全体の処理時間に影響するため、あわせて設定しておく価値があります。

このように、4つの対処はそれぞれ異なる層に効いており、原因がどの層にあるかによって、優先して見直すべき対処も変わってきます。次のセクションでは、この回で整理した内容を確認します。

---

[↑ 目次に戻る](#-目次)

---

## 7. まとめ

この回で整理した内容を確認します。

* SSHタイムアウトは一つの現象ではなく、接続確立時のタイムアウト（`ConnectTimeout`）と、転送中の無応答によるタイムアウト（`ServerAliveInterval`、`ServerAliveCountMax`）という、別の設定、別の原因で発生する2つの発生層に分かれる
* 現代のLinuxカーネルはTCPの送受信バッファサイズ、輻輳ウィンドウを通信状況に応じて自動調整するが、これは接続の効率を高める仕組みであり、タイムアウト値という固定の上限を引き上げるものではない。転送量、処理時間が既定のタイムアウト値を構造的に超えるリスクは残る
* VPN等のトンネリング経由やDockerのoverlayネットワーク経由の通信ではMTUが縮小し、フラグメンテーションと、それに伴う再送の積み重ねが遅延、パケットロスの原因になりうる
* Terraform側プロビジョナー（`local-exec`、`remote-exec`）とAnsible側（`ansible_ssh_common_args`、`timeout`）のタイムアウト設定は独立した仕組みであり、片方だけを調整しても意味がないケースがある。転送量に応じて双方を見積もる必要がある
* Ansible側では、SSH接続維持設定の明示、`synchronize`モジュールへの切り替え、処理の分割、`ansible_ssh_pipelining`の有効化という4つの観点で対処できる。それぞれが効く層は異なり、原因の層に応じて優先すべき対処を選ぶ

---

[↑ 目次に戻る](#-目次)

---

## 8. 次回予告

**[第22回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part3/ansible-terraform-part3-22/)** では、複数のDockerネットワークをアタッチした際に、HCL上の記述順序とコンテナ内部でのインターフェース割り当てが一致しない構造を扱い、経路そのものが意図しないインターフェースへ引きずられる問題を整理しました。**[第23回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part3/ansible-terraform-part3-23/)** となる今回は、経路自体は正しく到達している前提に立ち、大容量ファイル転送や重いタスク実行時に発生する速度、継続性の問題を扱いました。SSHタイムアウトの発生層、TCP、MTUというネットワーク層の要因、そしてTerraform、Ansible双方のタイムアウト設計が独立している構造を整理しました。

次回は、単一ホストへの転送時間、継続性の問題から離れ、複数のリソースを並列実行した際に、ホスト側のシステムリソースが構造的に枯渇しうる問題を扱います。

**[次回：第24回：並列実行時における実行ホストのシステムリソース枯渇対策](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part3/ansible-terraform-part3-24/)**

---

📑 連載の移動　**[前の記事：【Ansible×Terraform編】第22回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part3/ansible-terraform-part3-22/)　｜　[次の記事：【Ansible×Terraform編】第24回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part3/ansible-terraform-part3-24/)**

---

> **🗺️ 初めての方、シリーズの全体像を知りたい方はこちら**
> 
> シリーズ全体については、以下のまとめブログで整理しています。
> 
> → **「AnsibleとTerraformの連携が壊れる理由はライフサイクルにあった」シリーズ統合ブログ** **※近日公開予定**

---

[↑ 目次に戻る](#-目次)

---

## 9. 連載一覧：「AnsibleとTerraformの連携が壊れる理由はライフサイクルにあった」

#### 第3部：トラブルシューティング、デバッグ編

|回数|テーマ、記事タイトル|概要|
|---|---|---|
|**[第21回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part3/ansible-terraform-part3-21/)**|統合実行時におけるネストされたエラーログの解析手法|Terraformの`local-exec`経由で実行されたAnsibleのエラーログから、原因がTerraform側（HCL、State）かAnsible側（Playbook、タスク）かを特定する手法。|
|**[第22回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part3/ansible-terraform-part3-22/)**|マルチネットワーク環境におけるインターフェース競合|複数ネットワーク（Dockerネットワーク等）をアタッチした際、Ansibleの`ansible_default_ipv4`や接続IPの自動検出が意図しないインターフェースに引きずられる問題。|
|**[第23回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part3/ansible-terraform-part3-23/)**|大容量ファイル転送、重いタスク実行時におけるSSHタイムアウト|Ansibleで大きなアセットや大量のパッケージを転送、適用する際、Terraform側のプロビジョナータイムアウトに引っかかる可能性がある問題を扱う。|
|**[第24回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part3/ansible-terraform-part3-24/)**|並列実行時における実行ホストのシステムリソース枯渇対策|`parallelism`や`forks`設定により、大量のリソース構築とAnsibleプロビジョニングが同時に走った場合、ホストのCPU、メモリ、ファイルディスクリプタが枯渇しうる問題を扱う。|
|**[第25回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part3/ansible-terraform-part3-25/)**|構文チェックツール（HCL構文、ansible-lint）の競合緩和|両ツールの静的解析ツール（`terraform fmt`、`ansible-lint`）を導入した際、コード記述ルールや命名規則の不一致でCIが通らなくなる問題。|
|**[第26回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part3/ansible-terraform-part3-26/)**|管理者権限（sudo）実行時におけるパスワード入力のプロンプト停止|Terraformの`local-exec`や非対話シェルからAnsibleを実行した際、`sudo: a terminal is required to read the password`で停止する問題。|
|**[第27回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part3/ansible-terraform-part3-27/)**|再起動、再生成に伴うプロビジョニング断絶|Ansibleでカーネル更新等のためにOS再起動（またはコンテナ再起動、再生成）を要求した際、接続が途切れTerraformがエラー扱いする問題。|
|**[第28回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part3/ansible-terraform-part3-28/)**|異種OS（Windowsターゲット）混在環境における接続プロトコルの制約|SSHではなくWinRM等を用いる特殊プロトコル環境での接続、権限エラー。実務でWindows ServerをAnsible×Terraformで管理する際の構造的注意点を扱う概念解説回。|
|**[第29回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part3/ansible-terraform-part3-29/)**|プロキシ環境等における外部コレクション（Ansible Galaxy）の取得失敗|インフラ構築処理の途中で外部ネットワーク（Ansible Galaxy等）への依存が切れ、Terraformの処理全体が失敗する問題。|
|**[第30回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part3/ansible-terraform-part3-30/)**|デバッグフラグの組み合わせによるログ解析の高度化|Terraformの`TF_LOG`とAnsibleの`-vvvv`を組み合わせ、接続遅延や処理遅延のボトルネックを特定、解消する手法。|

---

[↑ 目次に戻る](#-目次)

---

