---
title: '「AnsibleとTerraformの連携が壊れる理由はライフサイクルにあった」 第24回：並列実行時における実行ホストのシステムリソース枯渇対策'  
description: 'Terraformの並列リソース生成とAnsibleのforks並列実行が同じコントロールホスト上で重なった場合に、CPU、メモリ、ファイルディスクリプタ等が構造的に圧迫されうる仕組みを整理する。症状の切り分け方法、並列度の制御による対処もあわせて扱う。'  
pubDate: '2026-09-14'  
category: 'infra'  
tags: ['Ansible', 'Terraform', '並列実行', 'リソース枯渇', 'forks']  
seriesId: 'ansible-terraform-part3'  
seriesNo: 24  
prevPost: '[https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part3/ansible-terraform-part3-23/](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part3/ansible-terraform-part3-23/)'  
nextPost: '[https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part3/ansible-terraform-part3-25/](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part3/ansible-terraform-part3-25/)'  
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
2. [Terraform側の並列実行の仕組み](#2-terraform側の並列実行の仕組み)
3. [Ansible側の並列実行の仕組み](#3-ansible側の並列実行の仕組み)
4. [並列処理が重なった際のプロセス数の増加](#4-並列処理が重なった際のプロセス数の増加)
5. [ホスト側リソースの圧迫パターン（構造上の整理）](#5-ホスト側リソースの圧迫パターン構造上の整理)
6. [症状が発生した場合の切り分け方法](#6-症状が発生した場合の切り分け方法)
7. [並列度の制御による対処](#7-並列度の制御による対処)
8. [まとめ](#8-まとめ)
9. [次回予告](#9-次回予告)
10. [連載一覧：「AnsibleとTerraformの連携が壊れる理由はライフサイクルにあった」](#10-連載一覧ansibleとterraformの連携が壊れる理由はライフサイクルにあった)

---

## 1. はじめに

「並列実行は速いから、常に有利だ」と考えたことはないでしょうか。

**[第21回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part3/ansible-terraform-part3-21/)** ではネストされたエラーログの解析手法を、**[第22回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part3/ansible-terraform-part3-22/)** ではマルチネットワーク環境でのインターフェース競合を、**[第23回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part3/ansible-terraform-part3-23/)** では大容量ファイル転送時のSSHタイムアウトを扱いました。この3回に共通するのは、いずれも実行結果側に現れる問題、つまりログの見え方、接続経路、転送速度という観点だった点です。

**[第24回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part3/ansible-terraform-part3-24/)** となる今回は視点を変えます。実行結果ではなく、実行元であるコントロールホスト自体が持つリソースという、これまで扱っていなかった層に注目します。

Terraformはデフォルトで複数リソースを並列に処理し、Ansibleもデフォルトで複数ホストに対してforks数分のプロセスを並列実行します。この2つの並列処理が同じコントロールホスト上で重なったとき、ホスト側のCPU、メモリ、SSH同時接続数、ファイルディスクリプタといったリソースは有限です。この回で扱う問いは、「並列実行の速さは、どのリソースを前提に成立しているのか」です。

次のセクションでは、この問いの前提となる、Terraform側の並列実行の仕組みから整理します。

---

[↑ 目次に戻る](#-目次)

---

## 2. Terraform側の並列実行の仕組み

この回の前提となる、Terraformの並列処理の挙動を整理します。

`terraform apply`はデフォルトで、複数のリソースの作成、変更を並列に処理します。

```
$ terraform apply
（デフォルトの並列数：-parallelism=10）
```

この並列数は、依存関係のないリソース同士が同時に処理されることを意味します。たとえば`null_resource`による`local-exec`呼び出しを複数のリソースに定義していた場合、それぞれの`local-exec`内で起動される処理も、この並列数の上限まで同時に走る可能性があります。

```
provisioner "local-exec" {
  command = "ansible-playbook -i inventory.ini site.yml"
}
```

このプロビジョナーがAnsibleの実行を呼び出す構成であれば、Terraformが依存関係のない複数のリソースを並列に処理する際、それぞれのリソースに紐づく`ansible-playbook`プロセスも、同じタイミングで同時に起動されうる構造になります。

`-parallelism`はTerraformの実行時オプションとしてコマンドラインから明示的に指定することもできます。

```
$ terraform apply -parallelism=3
```

このセクションは仕組みの説明にとどめ、実機での挙動確認は行いません。次のセクションでは、この並列実行と組み合わさるAnsible側の並列処理の仕組みを整理します。

---

[↑ 目次に戻る](#-目次)

---

## 3. Ansible側の並列実行の仕組み

前セクションではTerraform側の並列実行の仕組みを整理しました。このセクションでは、Ansible側が持つ並列処理の仕組みを整理します。

`ansible-playbook`はデフォルトで、複数のホストに対してforks数分のプロセスを並列実行します。

```
$ ansible-playbook -i inventory.ini site.yml
（デフォルトのforks数：forks=5）
```

forks数は`ansible.cfg`で設定するほか、実行時オプションとしてコマンドラインから指定することもできます。

```
[defaults]
forks = 5
```

```
$ ansible-playbook -i inventory.ini site.yml --forks=10
```

target-node1〜3のような複数台構成のインベントリに対して実行する場合、forks数の上限まで、同時にSSH接続とタスク実行が行われます。インベントリに含まれるホスト数がforks数より少なければ、実質的にはホスト数分の並列度にとどまりますが、対象ホストが増えるほど、forks数そのものが並列度の上限として効いてきます。

このforks数は、Ansible単体で実行する場合であっても、コントロールホスト側のCPU、メモリ、同時SSH接続数といったリソースを前提に成立している値です。次のセクションでは、このAnsible側の並列処理と、前セクションで整理したTerraform側の並列処理が組み合わさった場合に、プロセス数がどのように増加しうるかを整理します。

---

[↑ 目次に戻る](#-目次)

---

## 4. 並列処理が重なった際のプロセス数の増加

前セクションまでで、Terraform側の並列実行（`-parallelism`）とAnsible側の並列実行（`forks`）、それぞれの仕組みを個別に整理しました。このセクションでは、この2つが同じコントロールホスト上で組み合わさった場合の構造を整理します。

```
Terraformの並列実行（parallelism=10）
　├─ リソース1のlocal-exec → ansible-playbook起動（forks=5で最大5並列のSSH接続）
　├─ リソース2のlocal-exec → ansible-playbook起動（forks=5で最大5並列のSSH接続）
　├─ ...
　└─ リソース10のlocal-exec → ansible-playbook起動（forks=5で最大5並列のSSH接続）

理論上の最大同時SSH接続数：10（Terraform並列数）× 5（forks数）= 50
```

Terraformが並列に処理する10個のリソースそれぞれが、独立した`ansible-playbook`プロセスを起動し、そのそれぞれがforks数分のSSH接続を並列に張るとすれば、理論上の最大同時SSH接続数は両者の掛け算になります。この掛け算的な増加が、この回で扱う構造の核心です。

Terraform単体、あるいはAnsible単体で見積もっていたリソース消費量は、それぞれの並列数を前提とした値にすぎません。両者が同じホスト上で同時に走る構成では、見積もりの基準そのものを、単体の並列数ではなく掛け算後の数値に置き換える必要があります。実行規模がホストのキャパシティに対して相対的に大きくなるほど、CPU、メモリ、SSH同時接続数の想定を超えるリスクが高まる構造です。

なお、検証環境として使用しているDockerコンテナは軽量であることに加え、ホスト側のカーネルが持つリソース補正機能も働くため、通常の並列度やコンテナ数の範囲では、この掛け算的な増加によってホストのリソースが目に見えて逼迫する状況を安定的に作り出すことは容易ではありません。この回では、この構造そのものの整理を中心に進めます。

次のセクションでは、実行規模がホストのキャパシティを超えた場合に、具体的にどのリソースから枯渇しうるかを整理します。

---

[↑ 目次に戻る](#-目次)

---

## 5. ホスト側リソースの圧迫パターン（構造上の整理）

前セクションでは、TerraformとAnsibleの並列処理が組み合わさることで、プロセス数、SSH同時接続数が構造的に掛け算的に増加しうることを整理しました。このセクションでは、実行規模がホストのキャパシティを超えた場合に、具体的にどのリソースから枯渇しうるかを構造として整理します。

|圧迫されうるリソース|想定される症状|関連する仕組み|
|---|---|---|
|CPU|処理全体の遅延、応答の鈍化|プロセススケジューリングの飽和|
|メモリ|プロセスの強制終了|OOM Killerの発動|
|SSH同時接続数|新規接続の拒否、タイムアウト|sshd側の同時接続上限|
|ファイルディスクリプタ|新規プロセス、接続の失敗|プロセスごとのオープンファイル数上限（ulimit）|
|ディスクI/O|ログ書き込み待ちによる処理の停滞|I/Oスケジューラの飽和|

CPUが飽和すると、個々のプロセスに割り当てられる処理時間が短くなり、体感としては処理全体が遅くなる、応答が鈍くなるという形で現れます。メモリが不足すると、Linuxカーネルは特定のプロセスを強制的に終了させることでシステム全体の破綻を防ごうとします。これがOOM Killerの発動です。SSH同時接続数は、sshd側の設定（`MaxSessions`、`MaxStartups`等）によって上限が定められており、この上限に達すると新規の接続要求は拒否されるか、タイムアウトという形で現れます。ファイルディスクリプタは、プロセスごとに`ulimit`で上限が定められており、新規のプロセス起動や新規の接続確立ができなくなるという形で現れます。ディスクI/Oが飽和すると、ログの書き込みや一時ファイルの読み書きが滞り、処理全体が停滞します。

コンテナ環境では、これらに加えて、コンテナ自体の生成、破棄処理がホストリソースを圧迫する要因として重なりえます。イメージの展開、ネットワークの接続処理といったコンテナのライフサイクル操作自体が、CPUとディスクI/Oを消費するためです。並列に多数のコンテナを生成、破棄する構成では、この要因も見落とせません。

このセクションは、実行規模がキャパシティを超えた場合に何が起こりうるかという構造の整理にとどめ、実機での負荷再現、実演は行いません。次のセクションでは、こうした症状が実際に発生した場合に、どのリソースが原因かを調査する観測手法を整理します。

---

[↑ 目次に戻る](#-目次)

---

## 6. 症状が発生した場合の切り分け方法

前セクションでは、実行規模がホストのキャパシティを超えた場合に、どのリソースから枯渇しうるかを整理しました。このセクションでは、実際に症状が発生した場合に、どのリソースが原因かを調査する観測手法を整理します。実機で意図的に症状を発生させて確認するのではなく、発生した場合にどう調査するかという手順として位置づけます。

|症状|考えられる原因リソース|確認コマンド|
|---|---|---|
|処理全体が遅い|CPU|`top`|
|プロセスが突然消える|メモリ（OOM Kill）|`free`、`dmesg`|
|新規接続が失敗する|SSH同時接続数|`ss -tn`|
|新規プロセス起動に失敗する|ファイルディスクリプタ|`ulimit -n`、`lsof`|
|処理が停滞する|ディスクI/O|`iostat`|
|特定コンテナの負荷が高い|コンテナ単位のリソース|`docker stats`|

`top`はCPU使用率、プロセスごとの負荷を確認するための基本的なコマンドです。特定のプロセスがCPUを占有しているかどうかをここで確認します。プロセスが突然消えている場合は、`free`でメモリの空き状況を確認したうえで、`dmesg`のログを確認します。OOM Killerが発動した場合、`dmesg`には該当プロセスが強制終了された記録が残ります。

新規のSSH接続が失敗する場合は、`ss -tn`で現在の接続状況を確認し、同時接続数がsshd側の上限に達していないかを確認します。新規プロセスの起動やファイルのオープンに失敗する場合は、`ulimit -n`で現在のプロセスに設定されているファイルディスクリプタの上限を確認し、`lsof`で実際にどれだけのファイルディスクリプタが使用されているかを確認します。処理全体が停滞している場合は、`iostat`でディスクI/Oの待ち時間を確認します。コンテナ環境では、これらに加えて`docker stats`で個々のコンテナのCPU、メモリ使用率を確認し、特定のコンテナに負荷が偏っていないかを確認します。

```
症状を観測する（ハングアップ、タイムアウト、強制終了等）
　↓
上記の表を参考に、症状から考えられる原因リソースの当たりをつける
　↓
該当するコマンドで実際にそのリソースが枯渇しているかを確認する
```

次のセクションでは、こうした症状を未然に防ぐための、並列度の制御による対処を整理します。

---

[↑ 目次に戻る](#-目次)

---

## 7. 並列度の制御による対処

前セクションでは、症状が発生した場合の切り分け方法を整理しました。このセクションでは、こうした症状を未然に防ぐための、並列度の制御による対処を整理します。

```
【Terraform側】
-parallelism=N でTerraform自体の並列数を引き下げる
（terraform apply -parallelism=3 等）

【Ansible側】
forks の値をansible.cfgまたは実行時オプションで引き下げる
（ansible-playbook --forks=2 等）
```

いずれもコマンド一つで指定できる調整ですが、どちらか一方だけを絞ればよいのか、両方を絞る必要があるのかは、コントロールホストのリソースと、実行規模の関係によって変わります。

判断の起点は、コントロールホストのCPUコア数とメモリ量に対して、Terraformの並列数とAnsibleのforks数の掛け算が、どの程度の比率になっているかを見積もることです。**第4節**で整理した通り、理論上の最大同時接続数は両者の掛け算で決まります。この掛け算後の数値が、ホストが安定して処理できる同時接続数、同時プロセス数を大きく上回っている場合、片方だけを絞っても、もう片方の並列数がボトルネックとして残ります。

一方で、掛け算後の数値がホストのキャパシティをわずかに超える程度であれば、影響の大きい側から先に絞るという判断も成り立ちます。たとえば**第5節**で整理した通り、メモリ不足によるOOM Killerの発動が主な懸念であれば、メモリ消費の大きいプロセスを多く生成する側（forks数、あるいはTerraformの並列数のうちプロセス生成コストが高い方）を優先的に絞るという考え方です。SSH同時接続数の上限が主な懸念であれば、接続数に直結するforks数を優先して絞る方が、影響を抑えながら調整できます。

どちらを優先するかを一律に決めることはできず、実行規模、ホストのリソース、そして**第5節**で整理したどのリソースが枯渇しやすいかという見立てをあわせて判断する必要があります。次のセクションでは、この回で整理した内容をまとめます。

---

[↑ 目次に戻る](#-目次)

---

## 8. まとめ

この回で整理した内容を確認します。

- Terraformはデフォルトで複数リソースを並列に処理し（`-parallelism=10`）、Ansibleはデフォルトで複数ホストに対してforks数分のプロセスを並列実行する（`forks=5`）
- この2つの並列処理が同じコントロールホスト上で重なると、理論上の最大同時SSH接続数は両者の掛け算で決まり、プロセス数、接続数が構造的に増加しうる
- 実行規模がホストのキャパシティを超えた場合、CPU、メモリ、SSH同時接続数、ファイルディスクリプタ、ディスクI/Oのいずれかから枯渇しうる。コンテナ環境では、コンテナ自体の生成、破棄処理もホストリソースを圧迫する要因として重なりうる
- 症状が発生した場合は、`top`、`free`、`dmesg`、`ss -tn`、`ulimit -n`、`lsof`、`iostat`、`docker stats`等で、どのリソースが原因かを切り分けられる
- 対処はTerraform側の`-parallelism`とAnsible側の`forks`を引き下げることが基本だが、どちらを優先するかは、コントロールホストのリソースと、どのリソースが枯渇しやすいかという見立てをあわせて判断する必要がある

---

[↑ 目次に戻る](#-目次)

---

## 9. 次回予告

**[第23回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part3/ansible-terraform-part3-23/)** では、大容量ファイル転送や重いタスク実行時に発生する速度、継続性の問題を扱い、SSHタイムアウトの発生層、TCP、MTUというネットワーク層の要因を整理しました。**[第24回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part3/ansible-terraform-part3-24/)** となる今回は、単一ホストへの転送という視点から離れ、Terraformの並列リソース生成とAnsibleのforks並列実行が同じコントロールホスト上で重なった場合に、CPU、メモリ、ファイルディスクリプタ等が構造的に圧迫されうる仕組みを整理しました。

次回は、実行ホスト自体のリソースという制約から離れ、HCL構文チェックとansible-lintという、静的解析ツール同士のルールが競合する問題を扱います。

**[次回：第25回：構文チェックツール（HCL構文、ansible-lint）の競合緩和](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part3/ansible-terraform-part3-25/)**

---

📑 連載の移動　**[前の記事：【Ansible×Terraform編】第23回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part3/ansible-terraform-part3-23/)　｜　[次の記事：【Ansible×Terraform編】第25回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part3/ansible-terraform-part3-25/)**

---

> **🗺️ 初めての方、シリーズの全体像を知りたい方はこちら**
> 
> シリーズ全体については、以下のまとめブログで整理しています。
> 
> → **「AnsibleとTerraformの連携が壊れる理由はライフサイクルにあった」シリーズ統合ブログ** **※近日公開予定**

---

[↑ 目次に戻る](#-目次)

---

## 10. 連載一覧：「AnsibleとTerraformの連携が壊れる理由はライフサイクルにあった」

### 第3部：トラブルシューティング、デバッグ編

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
