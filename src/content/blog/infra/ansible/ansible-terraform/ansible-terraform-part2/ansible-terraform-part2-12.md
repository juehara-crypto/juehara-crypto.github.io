---
title: '「AnsibleとTerraformの連携が壊れる理由はライフサイクルにあった」 第12回：初期化スクリプト・コンテナ起動定義を変更してterraform applyを再実行すると、コンテナが作り直されてAnsibleの設定が消える理由―uploadブロックのforces replacementと、初期化処理とAnsibleの役割分離'
description: 'uploadブロックの追加でforces replacementが発生し、リソースが破棄、再生成されてAnsibleが設定したOS内部状態が消える構造を、実機ログで確認する。再生成後も初期化処理が書いたファイルは存在するという対比から、初期化処理とAnsibleの役割分離、lifecycle.ignore_changesによる保護とその限界を整理する。'
pubDate: '2026-08-19'
category: 'infra'
tags: ['Ansible', 'Terraform', 'ライフサイクル', '初期化スクリプト', 'lifecycle', 'forces replacement']
seriesId: 'ansible-terraform-part2'
seriesNo: 12
prevPost: 'https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part2/ansible-terraform-part2-11/'
nextPost: 'https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part2/ansible-terraform-part2-13/'
relatedSeries: ''
---

<style>
table th,
table td {
    word-break: normal;
}
table td:first-child {
    white-space: nowrap;
}
</style>



> **🗺️ 初めての方・シリーズの全体像を知りたい方はこちら**
> 
> シリーズ全体については、以下のまとめブログで整理しています。
> 
> → **[「AnsibleとTerraformの連携が壊れる理由はライフサイクルにあった」第2部まとめブログ： TerraformとAnsibleの運用で直面する構成ズレと状態管理の問題](https://qiita.com/juehara-crypto/items/c3e95e3bec11e07bbe75)**

---

> **🔍 今起きている症状・課題から、読むべき回を探したい方はこちら**
>
> 全50回で扱った症状・課題を、部をまたいで1か所に集めた逆引きリファレンスがあります。
> 症状・課題の一覧から原因の見当をつけ、該当する回のセクションまでたどれます。
>
> → **[「AnsibleとTerraformの連携が壊れる理由はライフサイクルにあった」逆引きリファレンス：全50回の症状・課題を5つの図から引く](https://qiita.com/juehara-crypto/items/bd2832993ef887e8022a)**

---

**※本記事の位置とシリーズ全体の関係を先に確認します。**

---

## 📍 本記事の位置

```mermaid
graph TD
    Main["統合ブログ<br/>シリーズ全体のナビゲーション"]

    subgraph Parts [各部のまとめブログ　全5本]
        Part1["第1部まとめブログ<br/>環境構築、連携編"]
        Part2["第2部まとめブログ<br/>運用、ライフサイクル編"]
        Part3["第3部まとめブログ<br/>トラブルシューティング、デバッグ編"]
        Part4["第4部まとめブログ<br/>改善、CI/CD自動化編"]
        Part5["第5部まとめブログ<br/>Terraformライフサイクル破壊編"]
    end

    subgraph Articles [各回ブログ　全50本]
        Part1_Detail["第1回〜第10回"]
        Part2_Detail["第11回〜第20回"]
        Part3_Detail["第21回〜第30回"]
        Part4_Detail["第31回〜第40回"]
        Part5_Detail["第41回〜第50回"]
    end

    Reverse["逆引きリファレンス<br/>全50回の症状・課題を集約"]

    Main --- Part1
    Main --- Part2
    Main --- Part3
    Main --- Part4
    Main --- Part5

    Part1 --- Part1_Detail
    Part2 --- Part2_Detail
    Part3 --- Part3_Detail
    Part4 --- Part4_Detail
    Part5 --- Part5_Detail

    Part1_Detail --- Reverse
    Part2_Detail --- Reverse
    Part3_Detail --- Reverse
    Part4_Detail --- Reverse
    Part5_Detail --- Reverse

    style Main fill:#e1f5fe,stroke:#01579b,stroke-width:3px
    style Part2_Detail fill:#fff3e0,stroke:#e65100,stroke-width:3px
    style Parts fill:none
    style Articles fill:none
```

本シリーズは、**[統合ブログ](https://qiita.com/juehara-crypto/items/5bd6720b7aaed13757f8)**、第1〜5部のまとめブログ（全5本）、第1〜50回の各回ブログ（全50本）の3階層で構成されています。**現在はこの図の下段、第2部「第11回〜第20回」のうちの第12回になります。** 統合ブログとまとめブログは、シリーズを上から順に読み進めるための入口です。

また、この3階層とは別に、**[逆引きリファレンス](https://qiita.com/juehara-crypto/items/bd2832993ef887e8022a)** があります。第1〜50回の各回ブログで扱った症状・課題を、部をまたいで1か所に集め、今起きている症状や解決したい課題から、該当する回へ直接たどり着けるようにしたものです。

---

## 📋 目次

1. [はじめに](#1-はじめに)
2. [初期化処理の基本動作](#2-初期化処理の基本動作)
3. [terraform apply再実行時の連鎖構造](#3-terraform-apply再実行時の連鎖構造)
4. [初期化スクリプト以外の変更が引き起こす再生成リスク](#4-初期化スクリプト以外の変更が引き起こす再生成リスク)
5. [消失を防ぐ設計パターン](#5-消失を防ぐ設計パターン)
6. [まとめ](#6-まとめ)
7. [次回予告](#7-次回予告)
8. [連載一覧：「AnsibleとTerraformの連携が壊れる理由はライフサイクルにあった」](#8-連載一覧ansibleとterraformの連携が壊れる理由はライフサイクルにあった)

---

## 1. はじめに

「`terraform apply`を実行しただけなのに、Ansibleで設定したはずの内容が消えていた」という経験はないでしょうか。

前回、**[第11回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part2/ansible-terraform-part2-11/)** では、手動でOS内部に変更を加えた際に、`terraform plan`と`ansible-playbook --check --diff`がそれぞれ独立した検知範囲を持つことを確認しました。一方の管理範囲での変化が、もう一方に伝わることはありません。この結果から導いた結論は、インフラ層とOS層を二軸として、どちらも確認、同期する必要があるというものでした。

今回扱う問題は、この前提が崩れるケースです。前回のテーマが「手動変更」という、Terraform、Ansibleどちらの正規の操作でもない外部からの変更だったのに対し、今回のテーマは「`terraform apply`という正規の操作そのもの」がAnsibleの設定を消失させるという点にあります。

具体的には、次のような場面です。

- コンテナ起動定義に少し手を加えて`terraform apply`を再実行した
- 特にAnsible側は何も変更していないのに、再実行後にOS内部の設定が消えている
- `terraform plan`は差分を正しく示していたはずなのに、その差分が何を意味するかを見落としていた

この事象の原因は、初期化スクリプトやコンテナ起動定義の性質と、Terraformがリソースをどう扱うかという2つの構造が連鎖することにあります。初期化スクリプトやコンテナ起動定義は、リソースの作成時（初回起動時）にのみ実行される仕組みです。この前提のもとで初期化スクリプトやコンテナ起動定義の内容を変更すると、Terraformはそれをリソース属性の変更として検知し、更新ではなく破棄、再生成という形で対応することがあります。リソースが再生成されれば、初期化処理も再実行されます。しかし、Ansibleが投入したOS内部の設定は、この初期化処理の管轄には含まれていません。結果として、リソースが新しく生成された直後の状態は、Ansible適用前の状態に戻っています。

この回では、「初期化処理とTerraformの再実行はどのように連鎖してOS層の消失を引き起こすか」という問いを軸に、この連鎖の構造を順番に整理します。まず次のセクションで、前提となる初期化処理そのものの基本動作を確認します。

---

[↑ 目次に戻る](#-目次)

---

## 2. 初期化処理の基本動作

この回の前提となる、初期化処理そのものの基本動作を整理します。

Terraformでコンテナやインスタンスといったリソースを生成する際、多くのプロバイダーには、リソースの起動と同時に何らかの初期処理を実行する仕組みが用意されています。AWSであれば`user_data`、Dockerプロバイダーであれば、コンテナの作成時にファイルを書き込む`upload`ブロックがこれにあたります。この回では、こうした仕組みをまとめて「初期化スクリプト・コンテナ起動定義」と呼びます。

初期化スクリプト・コンテナ起動定義には、次のような共通した性質があります。

- リソースの作成時（初回起動時）にのみ実行、反映される
- 通常の運用でリソースが再起動されても、初期化処理そのものは再実行されない
- 実行されるタイミングは、リソースが生成された直後、つまりOSやコンテナのプロセスが起動するタイミングに限られる

この性質から、初期化スクリプト・コンテナ起動定義は、Ansibleが動き出す前の最小限の前提条件を整えるという用途で使われることが多くあります。典型的な例は、次のようなものです。

- SSH公開鍵の配置
- Ansible実行に必要なPythonランタイムのインストール
- sudoersの設定

これらはいずれも、Ansibleがそのリソースに接続し、Playbookを実行できる状態にするための準備であり、OS設定の本体そのものではありません。実際の構成管理、つまりミドルウェアの導入や設定ファイルの配置、サービスの起動といった作業は、初期化処理の後にAnsibleが担うという役割分担が一般的です。

この関係を、リソース生成からAnsible実行までの流れとして図示します。

```mermaid
flowchart TB
    A["terraform apply（初回）"] --> B["リソースが生成される"]
    B --> C["初期化処理が実行される<br/>（初回のみ）"]
    C --> D["Ansibleが実行され<br/>OS設定が投入される"]
    D --> E["稼働状態"]

    classDef flowNode fill:#e8f0fe,stroke:#4472c4,stroke-width:1px,color:#1a1a1a
    class A,B,C,D,E flowNode
```

この図が示す流れの中で、注目したいのは「初期化処理が実行される」ステップに「初回のみ」という注記が付いている点です。この一度きりという性質そのものは、SSH鍵配置のような軽い前提条件整備を行う分には問題になりません。リソースが稼働し続けている限り、その配置内容は保持されたままだからです。

しかし、この「初回のみ」という性質は、リソースが破棄され、再生成されたときには別の意味を持ちます。再生成されたリソースにとっては、それもまた「初回起動」にあたるため、初期化処理は改めて実行されます。この初期化処理の再実行と、Ansibleが投入したOS設定の関係がどうなるかが、次のセクションで扱う核心の連鎖構造です。

---

[↑ 目次に戻る](#-目次)

---

## 3. terraform apply再実行時の連鎖構造

前セクションで、初期化スクリプト・コンテナ起動定義には「リソースの作成時（初回起動時）にのみ実行される」という性質があることを確認しました。この性質が、リソースの再生成というタイミングでどのような問題を引き起こすかを、実機で確認します。

まず、この連鎖の全体像を整理します。

```plaintext
初期化スクリプト・コンテナ起動定義を変更してterraform applyを再実行する
　↓
Terraformがリソースを破棄する　← Ansibleの設定がここで消える
　↓
リソースが再生成される
　↓
初期化処理が再実行される
　↓
Ansibleが再実行されない限りOS設定は投入されない　← ここが問題
```

ポイントは、Ansibleの設定が消えるタイミングが「リソースの破棄」の時点であるという点です。初期化処理の再実行はその後の話であり、初期化処理がどのような内容であっても、それによってAnsibleの設定が復元されるわけではありません。Ansibleが再実行されない限り、OS設定は空白のままになります。

この連鎖を、以下の手順で実機確認します。

```plaintext
1.【事前確認】Ansibleで設定を投入した状態のコンテナを用意する
　↓
2.【main.tfの編集】初期化スクリプト・コンテナ起動定義を変更する
　↓
3.【terraform plan】リソース再生成が予告されることを確認する
　↓
4.【terraform apply実行】リソースが再生成されAnsibleの設定が消えていることをログで確認する
　↓
5.【再生成後の状態確認】初期化処理管理下のファイルとAnsible管理下のファイルの状態を対比する
```

### ■ 検証内容（初期化スクリプト・コンテナ起動定義の変更が、Terraformによるリソース再生成とAnsible設定の消失を引き起こすことの確認）

検証には、`docker_container.targets`の`upload`ブロックを使用します。既存のSSH公開鍵投入用の`upload`ブロックとは別に、初期化処理を模したもう1つの`upload`ブロックを新たに追加します。追加するファイルは`/etc/init_marker`とし、Ansible管理下の`/etc/app.conf`とは異なり、初期化処理そのものが書き込むファイルという位置づけにします。この2つのファイルの状態を対比することで、初期化処理の管理範囲とAnsibleの管理範囲の違いを確認します。

#### 1.【事前確認】

target-node1の`/etc/app.conf`が、**[第11回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part2/ansible-terraform-part2-11/)** 完了時点のdesired state（`environment=production`）のまま残っていることを確認します。

**実行コマンド**

```plaintext
docker exec -it target-node1 cat /etc/app.conf
```

**▼ 実行結果**

```plaintext
environment=production
managed_by=ansible
```

Ansibleが投入した設定が維持されていることが確認できました。この状態を起点として、`main.tf`に変更を加えます。

#### 2.【main.tfの編集】

`docker_container.targets`リソースに、既存のSSH公開鍵投入用の`upload`ブロックはそのまま残し、初期化処理を模した2つ目の`upload`ブロックを追加します。

* **ファイル名：**`main.tf`

```hcl
resource "docker_container" "targets" {
  for_each = local.target_nodes
  name  = each.key
  image = docker_image.ansible_target.image_id
  networks_advanced {
    name = docker_network.lab_net.name
  }
  ports {
    internal = 22
    external = each.value
  }
  upload {
    file    = "/home/ansible/.ssh/authorized_keys"
    content = "${file("${path.module}/id_ed25519.pub")}\n${tls_private_key.generated.public_key_openssh}"
  }
  upload {
    file    = "/etc/init_marker"
    content = "init_version=v1\n"
  }

  lifecycle {
    ignore_changes = [network_mode]
  }
}
```

追加したのは2つ目の`upload`ブロックのみです。既存のSSH公開鍵投入用のブロック、`lifecycle`ブロックには変更を加えていません。

#### 3.【terraform plan】

編集後の`main.tf`で、`terraform plan`を実行します。

**実行コマンド**

```plaintext
terraform plan
```

**▼ 実行結果**

```plaintext
  # docker_container.targets["target-node1"] must be replaced
-/+ resource "docker_container" "targets" {
      + bridge                                      = (known after apply)
      ~ command                                     = [
          - "/usr/sbin/sshd",
          - "-D",
        ] -> (known after apply)
      + container_logs                              = (known after apply)
      - cpu_shares                                  = 0 -> null
      - dns                                         = [] -> null
      - dns_opts                                    = [] -> null
      - dns_search                                  = [] -> null
      ~ entrypoint                                  = [] -> (known after apply)
      ~ env                                         = [] -> (known after apply)
      + exit_code                                   = (known after apply)
      - group_add                                   = [] -> null
      ~ hostname                                    = "f8fdc553391c" -> (known after apply)
      ~ id                                          = "f8fdc553391c6aca63db17cb5f559837b1c4a800327eb1e14727aadf238c41c1" -> (known after apply)
      ~ init                                        = false -> (known after apply)
      ~ ipc_mode                                    = "private" -> (known after apply)
      ~ log_driver                                  = "json-file" -> (known after apply)
      - log_opts                                    = {} -> null
      - max_retry_count                             = 0 -> null
      - memory                                      = 0 -> null
      - memory_swap                                 = 0 -> null
        name                                        = "target-node1"
      ~ network_data                                = [
          - {
              - gateway                   = "172.20.0.1"
              - global_ipv6_prefix_length = 0
              - ip_address                = "172.20.0.2"
              - ip_prefix_length          = 24
              - mac_address               = "02:0d:fc:94:33:79"
              - network_name              = "ansible-lab-net"
                # (2 unchanged attributes hidden)
            },
        ] -> (known after apply)
      - network_mode                                = "bridge" -> null
      - privileged                                  = false -> null
      - publish_all_ports                           = false -> null
      ~ runtime                                     = "runc" -> (known after apply)
      ~ security_opts                               = [] -> (known after apply)
      ~ shm_size                                    = 64 -> (known after apply)
      + stop_signal                                 = (known after apply)
      ~ stop_timeout                                = 0 -> (known after apply)
      - storage_opts                                = {} -> null
      - sysctls                                     = {} -> null
      - tmpfs                                       = {} -> null
        # (20 unchanged attributes hidden)

      ~ healthcheck (known after apply)

      ~ labels (known after apply)

      + upload { # forces replacement
          + content        = <<-EOT
                init_version=v1
            EOT
          + executable     = false
          + file           = "/etc/init_marker"
            # (3 unchanged attributes hidden)
        }

        # (3 unchanged blocks hidden)
    }

（…target-node2、target-node3も同一の差分パターンのため省略…）

  # local_file.ansible_inventory must be replaced
-/+ resource "local_file" "ansible_inventory" {
      ~ content              = <<-EOT
            [target_nodes]
            target-node1 ansible_host=172.20.0.2 ansible_user=ansible
            target-node2 ansible_host=172.20.0.3 ansible_user=ansible
            target-node3 ansible_host=172.20.0.4 ansible_user=ansible
        EOT -> (known after apply) # forces replacement
      ~ content_base64sha256 = "KkhXlZx8nXgEIxclamFBSrbZuIAejMcbDM6fM1+nHzQ=" -> (known after apply)
      ~ content_base64sha512 = "JqWDZ+y9FmkNXVRT5t2BYMRUMEqmtvutqyvo6SY/UEg9IP2BonqA4BIZtAuqjjuMoJ9CTLChP+O6D8jwKAAwrQ==" -> (known after apply)
      ~ content_md5          = "04a6ce20acc9e3d6846519cf5de141d9" -> (known after apply)
      ~ content_sha1         = "5be39bf94b8b814c5107e1a0cf2248e68b7e1ff8" -> (known after apply)
      ~ content_sha256       = "2a4857959c7c9d78042317256a61414ab6d9b8801e8cc71b0cce9f335fa71f34" -> (known after apply)
      ~ content_sha512       = "26a58367ecbd16690d5d5453e6dd8160c454304aa6b6fbadab2be8e9263f50483d20fd81a27a80e01219b40baa8e3b8ca09f424cb0a13fe3ba0fc8f0280030ad" -> (known after apply)
      ~ id                   = "5be39bf94b8b814c5107e1a0cf2248e68b7e1ff8" -> (known after apply)
        # (3 unchanged attributes hidden)
    }

Plan: 4 to add, 0 to change, 4 to destroy.

Changes to Outputs:
  ~ target_nodes_ips = {
      ~ target-node1 = "172.20.0.2" -> (known after apply)
      ~ target-node2 = "172.20.0.3" -> (known after apply)
      ~ target-node3 = "172.20.0.4" -> (known after apply)
    }
```

target-node1〜3のすべてに`must be replaced`が表示され、その根拠として`+ upload { # forces replacement ... file = "/etc/init_marker" }`が明示されています。`upload`ブロックへの追加が`forces replacement`、つまり更新ではなく破棄、再生成としてTerraformに扱われることが分かります。

なお、同じ出力の中には`- network_mode = "bridge" -> null`という表示もありますが、これは検証環境の`docker_container.targets`で`lifecycle`ブロックの`ignore_changes`に指定している属性であり、`forces replacement`のマーカーは付いていません。再生成の引き金が`upload`ブロックの変更であることは、出力上ここで明確に切り分けられます。

#### 4.【terraform apply実行】

**実行コマンド**

```plaintext
terraform apply
```

`yes`で承認すると、target-node1〜3が破棄、再生成されました。

**▼ 実行結果**

```plaintext
Do you want to perform these actions?
  Terraform will perform the actions described above.
  Only 'yes' will be accepted to approve.

  Enter a value: yes

local_file.ansible_inventory: Destroying... [id=5be39bf94b8b814c5107e1a0cf2248e68b7e1ff8]
local_file.ansible_inventory: Destruction complete after 0s
docker_container.targets["target-node2"]: Destroying... [id=b3d6800ee8694dec1ee560e47404061400492a398bd18ab0421d81bb945e0509]
docker_container.targets["target-node3"]: Destroying... [id=b775be160b37ac7312676950171a5c77d4a37786d62444342a4754041f49032e]
docker_container.targets["target-node1"]: Destroying... [id=f8fdc553391c6aca63db17cb5f559837b1c4a800327eb1e14727aadf238c41c1]
docker_container.targets["target-node1"]: Destruction complete after 2s
docker_container.targets["target-node3"]: Destruction complete after 2s
docker_container.targets["target-node3"]: Creating...
docker_container.targets["target-node1"]: Creating...
docker_container.targets["target-node2"]: Destruction complete after 2s
docker_container.targets["target-node2"]: Creating...
docker_container.targets["target-node3"]: Creation complete after 2s [id=5b821b7a628a025235fa17daf68de33590c91ebdc89c5c371e32d67d9299878b]
docker_container.targets["target-node2"]: Creation complete after 3s [id=0de2e5df61721ff60bf8afde7f9dc5d16ebeda0a9f387571efea07e1bf87d0ca]
docker_container.targets["target-node1"]: Creation complete after 3s [id=c207933bacf2af6824303c3d9f99155398618f4f89b6c3444ed0fd5436eacac6]
local_file.ansible_inventory: Creating...
local_file.ansible_inventory: Creation complete after 0s [id=733afaba17b50383acf6b02a681a2bf4379feed0]

Apply complete! Resources: 4 added, 0 changed, 4 destroyed.

Outputs:

target_nodes_ips = {
  "target-node1" = "172.20.0.4"
  "target-node2" = "172.20.0.3"
  "target-node3" = "172.20.0.2"
}
```

3台とも新しいコンテナとして再生成されました。IPアドレスも再生成前後で変わっており、target-node2のみ元と同じ`172.20.0.3`が割り当てられ、target-node1とtarget-node3は入れ替わっています。コンテナを再生成すると、IPアドレスの割り当てが再生成前と一致するとは限りません。

#### 5.【再生成後の状態確認】

再生成されたコンテナで、Ansible管理下の`/etc/app.conf`と、初期化処理管理下の`/etc/init_marker`をそれぞれ確認します。

**実行コマンド**

```plaintext
docker exec -it target-node1 cat /etc/app.conf
docker exec -it target-node2 cat /etc/app.conf
docker exec -it target-node3 cat /etc/app.conf
```

**▼ 実行結果**

```plaintext
cat: /etc/app.conf: No such file or directory
cat: /etc/app.conf: No such file or directory
cat: /etc/app.conf: No such file or directory
```

3台とも、Ansibleが投入したはずの`/etc/app.conf`が存在しなくなっています。

**実行コマンド**

```plaintext
docker exec -it target-node1 cat /etc/init_marker
```

**▼ 実行結果**

```plaintext
init_version=v1
```

一方、初期化処理が新たに書き込んだ`/etc/init_marker`は、指定した内容通りに存在しています。

### ■ 結果

この検証から、次の2点が確認できました。

1つ目は、初期化スクリプト・コンテナ起動定義への変更が、Terraformによるリソースの破棄、再生成を引き起こすという点です。`terraform plan`の出力では、この再生成の根拠が`forces replacement`という形で該当の属性に明示され、`network_mode`のような`lifecycle.ignore_changes`の対象属性とは区別されていました。

2つ目は、この破棄、再生成によって、Ansibleが投入した設定（`/etc/app.conf`）が消失する一方、初期化処理が新たに書き込んだ内容（`/etc/init_marker`）は再生成後のコンテナにそのまま反映されるという点です。この対比は、初期化処理とAnsibleがそれぞれ別のタイミング、別の管理範囲で動作していることを示しています。初期化処理は「リソースが生成された直後」という一時点のみに関与し、その後の状態を維持し続けるものではありません。一方、Ansibleが投入した設定は、リソースが存続している間は維持されますが、リソースそのものが破棄されれば、その内容も一緒に失われます。

Ansibleを再実行すれば、この`/etc/app.conf`は再び投入され、desired stateに復帰します。しかし、これは自動では起きません。リソースの再生成後、Ansibleの再実行が行われるまでの間、OS設定は空白のままになるという点が、この回の核心にある問題です。

---

[↑ 目次に戻る](#-目次)

---

## 4. 初期化スクリプト以外の変更が引き起こす再生成リスク

前セクションでは、初期化スクリプト・コンテナ起動定義そのものの変更が、リソースの破棄、再生成を引き起こす様子を実機で確認しました。ここで整理しておきたいのは、リソースが破棄、再生成される条件は、初期化スクリプト・コンテナ起動定義の変更に限られないという点です。

Terraformは、リソース定義の属性変更に対して、常に「更新」で対応するわけではありません。属性の種類によっては、更新では反映できないと判断し、リソースを一度破棄してから作り直すという形で対応します。`terraform plan`の出力では、この場合にリソースの先頭へ`-/+`が表示され、再生成の引き金になった属性には`forces replacement`という注記が付きます。

前セクションで確認した`upload`ブロックの変更も、この`forces replacement`が付く変更の一例でした。そして再生成を引き起こす属性は、初期化スクリプトに相当するものだけではありません。`docker_container`リソースの場合、例えば次の属性の変更でも再生成が起きます。

- ポートマッピングの変更
- 環境変数の追加
- ラベルの追加

これらは、**[第13回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part2/ansible-terraform-part2-13/)** の実機検証で、`terraform plan`に`-/+`と`forces replacement`が表示されることを確認した属性です。どの属性が再生成になるかは、プロバイダーとリソースごとに決まっています。

ここで重要なのは、前セクションで整理した連鎖の構造そのものは変わらないという点です。前セクションで確認した通り、Ansibleの設定が消えるのは「リソースの破棄」の時点であり、その後の初期化処理の再実行はこの連鎖の一部にすぎません。したがって、初期化スクリプト・コンテナ起動定義を一切変更していなくても、他の属性変更によって再生成が発生すれば、リソースは同じように破棄、再生成され、Ansibleが投入したOS内部の設定は同じように消失します。

前セクションの実機検証でも、この構造の一端はすでに出力に表れていました。`terraform plan`の結果には`+ upload { # forces replacement ... }`という表示とともに、`- network_mode = "bridge" -> null`という表示も含まれていましたが、`network_mode`側には`forces replacement`のマーカーは付いていませんでした。これは、`network_mode`が`lifecycle.ignore_changes`の対象になっているため、この属性の変更自体は無視され、再生成の判断材料になっていないことを示しています。裏を返せば、もし`network_mode`が`ignore_changes`の対象になっていなければ、この属性の変更単独でも再生成が発生し得るということです。属性ごとに「更新で反映できるか、破棄、再生成が必要か」という性質が個別に決まっている、という点がここから読み取れます。

前セクションで確認した`docker_container.targets`の出力でも、再生成が発生するリソースの先頭には`-/+`が表示されていました。この`-/+`は、単なる属性の更新（`~`）とは明確に区別されており、`apply`を実行する前に、この記号を確認する習慣があれば、意図しないリソースの再生成を事前に把握できます。

初期化スクリプト・コンテナ起動定義の変更に限らず、どの属性が再生成を引き起こすかを網羅的に把握することは、この回の範囲を超えます。ここで押さえておきたいのは、「初期化スクリプトを変更していないから安全」とは言えないという点です。次のセクションでは、再生成そのものを完全には避けられないという前提に立ったうえで、Ansibleの設定消失をどう防ぐかという設計パターンを整理します。

---

[↑ 目次に戻る](#-目次)

---

## 5. 消失を防ぐ設計パターン

セクション3、4で整理した内容を振り返ります。初期化スクリプト・コンテナ起動定義の変更、あるいはそれ以外の属性変更のどちらであっても、再生成が発生すればリソースは破棄、再生成され、Ansibleが投入したOS内部の設定は消失します。この回の最後に、この消失リスクに対する設計パターンを整理します。

### 初期化スクリプト・コンテナ起動定義の役割を最小限に絞る

1つ目のパターンは、初期化スクリプト・コンテナ起動定義に書く内容そのものを見直すという考え方です。

セクション2で整理した通り、初期化スクリプト・コンテナ起動定義の典型的な用途は、SSH鍵配置やPythonインストールといった、Ansible実行前の前提条件整備でした。この役割を、文字通り「Ansibleが接続し、実行できる状態にするための最小限の準備」に絞り込み、それ以外のOS設定はすべてAnsibleに集約します。

この役割分担を徹底しておくと、リソースが再生成された場合の被害の範囲が変わります。初期化スクリプト・コンテナ起動定義の内容が最小限であれば、再生成後に失われるのは「Ansibleがまだ実行されていない」という一時的な状態だけです。Ansibleを再実行すれば、OS設定は同じ手順で同じ状態に復元されます。逆に、初期化スクリプト・コンテナ起動定義にOS設定の本体まで書き込んでしまっていると、その内容自体を前セクションで整理した属性変更のたびに書き換えることになり、再生成を誘発する頻度そのものが増えることにもつながります。

これは新しい技術要素を導入する設計パターンではなく、初期化処理とAnsibleという2つの仕組みの役割を、それぞれの得意な範囲に収めるという整理です。セクション3の検証で使った`/etc/init_marker`と`/etc/app.conf`の対比は、この役割分担が実際に機能した場合の姿を示していました。`/etc/init_marker`側は再生成のたびに新しく作られますが、それは初期化処理の役割の範囲内であり、問題にはなりません。問題になるのは、`/etc/app.conf`のような、本来Ansibleが継続的に管理すべき内容が、初期化スクリプト・コンテナ起動定義の側に書かれてしまっているケースです。

### lifecycle設定による保護

2つ目のパターンは、`lifecycle`ブロックの`ignore_changes`を使い、特定の属性変更そのものをTerraformに無視させる方法です。

```hcl
resource "docker_container" "example" {
  # ...

  lifecycle {
    ignore_changes = [初期化スクリプトに相当する属性]
  }
}
```

この設定を加えると、指定した属性に変更が加わっても、`terraform plan`はその変更を差分として検知しません。結果として、その属性の変更を理由にした再生成は発生せず、リソースの破棄、再生成も起きません。

この方法は、今回の検証環境ですでに実例があります。`terraform plan`のたびに`network_mode`が`"bridge" -> null`という差分として表示され、再生成の対象になってしまうことへの対応として入れている、以下の設定です。

```hcl
resource "docker_container" "targets" {
  # ...
  lifecycle {
    ignore_changes = [network_mode]
  }
}
```

この設定により、`network_mode`の変更は無視され、この属性を理由にした再生成は起きません。同じ考え方を初期化スクリプトに相当する属性（`docker_container`であれば`upload`など）に適用すれば、その属性の変更による再生成を防げる考え方になります（この回では`upload`への適用は実測していません）。

ただし、この方法には明確な適用範囲の限界があります。`ignore_changes`が防げるのは、あくまで「配列に指定した、その属性の変更」を理由にした再生成だけです。セクション4で整理した通り、再生成はポートマッピングや環境変数、ラベルといった、初期化スクリプトとは無関係の属性変更によっても発生します。`ignore_changes`にどれだけ属性を追加しても、指定していない属性の変更による再生成までは防げません。

さらに、`ignore_changes`で変更を無視するということは、その属性については、HCLコード側の記述と実際のリソースの状態が乖離したまま放置されるということでもあります。**[第11回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part2/ansible-terraform-part2-11/)** で整理した通り、`terraform plan`が検知する範囲はtfstateが管理する属性に限られますが、`ignore_changes`はその検知範囲の中から、意図的に一部を除外する設定です。除外した属性について、HCLコードを見ただけでは実際の値が分からなくなるという副作用は、この設定を使う際に理解しておく必要があります。

### 2つのパターンの関係

この2つのパターンは、どちらか一方を選ぶものではなく、組み合わせて運用するものです。初期化スクリプト・コンテナ起動定義の役割を最小限に絞ることは、再生成が発生した場合の被害を小さくする設計であり、`lifecycle.ignore_changes`は、特定の属性変更について再生成の発生そのものを防ぐ設計です。前者はリソース再生成が起きること自体を前提にした備えであり、後者は特定の条件下での再生成を未然に防ぐ備えです。

セクション4で整理した通り、再生成を引き起こす属性は初期化スクリプトに限らず、`ignore_changes`で全ての属性をカバーすることは現実的ではありません。したがって、`ignore_changes`で防げる範囲には限界があるという前提に立ったうえで、初期化スクリプト・コンテナ起動定義の役割を最小限に絞り、OS設定の本体をAnsibleに集約しておくという設計が、この回で整理した消失リスクに対する基本的な備え方になります。

---

[↑ 目次に戻る](#-目次)

---

## 6. まとめ

この回で整理した内容を確認します。

* 初期化スクリプト・コンテナ起動定義はリソースの作成時（初回起動時）にのみ実行される仕組みであり、通常の運用でリソースが再起動されても再実行されない。ただし、リソースが破棄、再生成された場合は、それも「初回起動」にあたるため、初期化処理は改めて実行される
* `upload`ブロックの追加のような初期化スクリプト・コンテナ起動定義の変更は、`terraform plan`で`forces replacement`と表示され、Terraformによるリソースの破棄、再生成を引き起こす。Ansibleの設定が消えるのはこの破棄の時点であり、初期化処理の再実行そのものはOS設定を復元しない
* 再生成を引き起こす属性は初期化スクリプト・コンテナ起動定義に限られない。ポートマッピングや環境変数、ラベルといった他の属性変更によっても同様の破棄、再生成が発生し得る
* `terraform plan`が出力する`-/+`という記号と`forces replacement`の注記は、リソースが再生成されることを示す。`apply`前にこれらを確認する習慣が、意図しない再生成の把握につながる
* 消失を防ぐ設計パターンとして、初期化スクリプト・コンテナ起動定義の役割をAnsible実行前の最小限の前提条件整備に絞り、OS設定の本体をAnsibleに集約する方法と、`lifecycle { ignore_changes }`で特定の属性変更を無視する方法がある。両者は組み合わせて運用するものであり、`ignore_changes`は指定した属性以外の変更による再生成までは防げない

---

[↑ 目次に戻る](#-目次)

---

## 7. 次回予告

**[第11回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part2/ansible-terraform-part2-11/)** では、手動変更によるドリフトの検知と同期を扱いました。今回はその視点を変え、`terraform apply`という正規の操作そのものが、Ansibleの設定を消失させる引き金になるという構造を整理しました。初期化スクリプト・コンテナ起動定義の変更が`forces replacement`を引き起こし、リソースの破棄、再生成によってAnsibleの設定が消えるという連鎖、そしてこの再生成が初期化スクリプトの変更に限らず発生し得るという点を確認しました。

次回は、この再生成という現象そのものに焦点を絞り込みます。今回は再生成を引き起こす属性を代表例にとどめましたが、次回は、HCLの1行の変更が「更新」と「破棄、再生成」のどちらになるかの分かれ目を実機で確かめ、`terraform plan`の`-/+`と`forces replacement`の表示から、`apply`前に再生成を見分ける方法を扱います。

**[次回：第13回：HCLの1行の変更でコンテナが破棄、再生成され、Ansibleの設定が消える理由](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part2/ansible-terraform-part2-13/)**

---

📑 連載の移動　**[前の記事：【Ansible×Terraform編】第11回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part2/ansible-terraform-part2-11/)　｜　[次の記事：【Ansible×Terraform編】第13回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part2/ansible-terraform-part2-13/)**

---

> **🗺️ 初めての方・シリーズの全体像を知りたい方はこちら**
> 
> シリーズ全体については、以下のまとめブログで整理しています。
> 
> → **[「AnsibleとTerraformの連携が壊れる理由はライフサイクルにあった」第2部まとめブログ： TerraformとAnsibleの運用で直面する構成ズレと状態管理の問題](https://qiita.com/juehara-crypto/items/c3e95e3bec11e07bbe75)**

---

> **🔍 今起きている症状・課題から、読むべき回を探したい方はこちら**
>
> 全50回で扱った症状・課題を、部をまたいで1か所に集めた逆引きリファレンスがあります。
> 症状・課題の一覧から原因の見当をつけ、該当する回のセクションまでたどれます。
>
> → **[「AnsibleとTerraformの連携が壊れる理由はライフサイクルにあった」逆引きリファレンス：全50回の症状・課題を5つの図から引く](https://qiita.com/juehara-crypto/items/bd2832993ef887e8022a)**

---


[↑ 目次に戻る](#-目次)

---

## 8. 連載一覧：「AnsibleとTerraformの連携が壊れる理由はライフサイクルにあった」

### 第2部：運用、ライフサイクル編

|回数|テーマ、記事タイトル|概要|
|---|---|---|
|**[第11回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part2/ansible-terraform-part2-11/)**|Terraformのplanが、手動やAnsibleによるOS内部の変更を検知できない理由―tfstateの管理範囲と、--check --diffによる補完|構築後に手動やAnsibleで変更したOS内部の状態は、tfstateの管理範囲の外にあるため、Terraformの`plan`では検知できない。Ansibleの`--check --diff`による補完と、インフラ層、OS層を二軸で確認、同期する手順を整理する。ドリフトシリーズとの接続を示す。|
|**[第12回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part2/ansible-terraform-part2-12/)**|初期化スクリプト・コンテナ起動定義を変更してterraform applyを再実行すると、コンテナが作り直されてAnsibleの設定が消える理由―uploadブロックのforces replacementと、初期化処理とAnsibleの役割分離|初期化スクリプトやコンテナ起動定義の変更で`forces replacement`が発生し、リソースが破棄、再生成されて、Ansibleが設定済みのOS内部状態が消える課題。初期化処理とAnsibleの役割分離で消失の影響を小さくする設計を整理する。|
|**[第13回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part2/ansible-terraform-part2-13/)**|HCLの1行の変更でコンテナが破棄、再生成され、Ansibleの設定が消える理由―更新と再生成の分かれ目と、terraform planの「-/+」「forces replacement」による事前判定|HCLの1行の変更でも、属性によっては「更新」ではなく「破棄、再生成」となり、Ansibleが投入した設定が消える。`terraform plan`の`~`と`-/+`、`forces replacement`の注記から、`apply`前に再生成を見分ける方法を整理する。|
|**[第14回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part2/ansible-terraform-part2-14/)**|local-execで再実行されたAnsibleが失敗し、terraform applyが止まる理由―冪等でないcommand（mkdir）と、--check --diffでは検出できない限界|`local-exec`経由でAnsibleが複数回実行される構成で、冪等でないPlaybookが2回目の実行で失敗し、`terraform apply`自体の失敗につながる問題。専用モジュールへの置き換えと、`--check --diff`では検出できない限界を整理する。冪等性シリーズ、レガシーPlaybook引き継ぎの知識を実践に適用する回として位置づける。|
|**[第15回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part2/ansible-terraform-part2-15/)**|複数人が別々のディレクトリでterraform applyしたtfstateを上書きすると記録が消え、出力名の変更だけでAnsibleのスクリプトも止まる理由―state lockingの守備範囲と、中間ファイルによる分離|複数人が別々のディレクトリで扱ったtfstateを上書きすると記録が消える問題と、Ansible担当がtfstateを直接参照すると、出力名の変更だけでスクリプトが止まる問題。state lockingの守備範囲と、中間ファイルによる分離、apply実行権限の設計を整理する。|
|**[第16回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part2/ansible-terraform-part2-16/)**|apt update／apt upgradeでパッケージが更新されると、バージョンを前提にしたAnsible Playbookが失敗する理由―Terraformのイメージ固定の範囲外と、aptモジュールでのバージョン指定|運用中に`apt update`、`apt upgrade`でパッケージが更新されると、バージョンを前提にしたAnsible Playbookが失敗する問題。Terraformのイメージ固定が及ばない範囲と、`apt`モジュールでのバージョン指定による制御を整理する。|
|**[第17回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part2/ansible-terraform-part2-17/)**|リソースの再生成でIPアドレスが変わると、静的インベントリのままではAnsibleがUNREACHABLEになる理由―動的インベントリで追従できる範囲と、DNS・hostsなど追従できない参照|リソースの再生成でIPアドレスが変わると、書き換えていない静的インベントリではAnsibleが`UNREACHABLE`になる問題。動的インベントリで追従できる範囲と、DNSや`/etc/hosts`など追従できない参照を整理する。|
|**[第18回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part2/ansible-terraform-part2-18/)**|sensitive = trueを指定してもtfstateにパスワードが平文で残る理由―Ansible Vaultとの責務分担と、Vaultの誤用パターン|`sensitive = true`を指定しても、`output`の値がtfstateに平文で残る問題。TerraformとAnsible Vaultの責務分担と、Vaultの誤用パターンと回避策を整理する。|
|**[第19回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part2/ansible-terraform-part2-19/)**|ベースイメージをUbuntu 22.04から24.04に切り替えると、ansible_python_interpreterでPython 3.10を固定したPlaybookがnot foundで失敗する理由―自動検出との違いと、/etc/apt/sources.listの形式変更|ベースイメージをUbuntu 22.04から24.04に切り替えると、`ansible_python_interpreter`をパスで固定したPlaybookが`not found`で失敗する問題。自動検出との違いと、`/etc/apt/sources.list`の形式変更、標準モジュールの抽象化の限界を整理する。|
|**[第20回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part2/ansible-terraform-part2-20/)**|運用編まとめ：第11〜19回のトラブルは、リソースを直し続ける運用と作り直す運用のどちらで起きるか―ステートフルならミュータブル、ステートレスならイミュータブルという使い分け|第11〜19回のトラブルを、リソースを直し続けるミュータブル運用と、作り直すイミュータブル運用の軸で整理する。ステートフルならミュータブル、ステートレスならイミュータブルという使い分けを着地点として示す。|

---

[↑ 目次に戻る](#-目次)

---