---
title: '「AnsibleとTerraformの連携が壊れる理由はライフサイクルにあった」 第41回：なぜTerraformはAnsibleが投じた設定を知らないのか'
description: 'TerraformのState管理メカニズムを整理し、tfstateが記録する範囲と、Ansibleがコンテナ内部に投じる設定変更がその管理範囲の外側にある構造を解剖する。TerraformとAnsibleそれぞれの管理範囲が独立しているという「認識の不可視性」を、第5部全体を貫く軸として提示する。'
pubDate: 2026-09-09
category: 'infra'
tags: ['Ansible', 'Terraform', 'tfstate', 'State管理', 'ドリフト']
seriesId: 'ansible-terraform-part5'
seriesNo: 41
prevPost: 'https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part4/ansible-terraform-part4-40/'
nextPost: 'https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part5/ansible-terraform-part5-42/'
relatedSeries: ''
---

<style> table th, table td { word-break: normal; } table td:first-child { white-space: nowrap; } </style>

> **🗺️ 初めての方、シリーズの全体像を知りたい方はこちら**
>
> シリーズ全体については、以下のまとめブログで整理しています。
>
> → **「AnsibleとTerraformの連携が壊れる理由はライフサイクルにあった」第5部まとめブログ：Terraformライフサイクル破壊編で明らかになった「認識の不可視性」の構造** **※近日公開予定**

---

## 📋 目次

1. [はじめに](#1-はじめに)
2. [tfstateが記録する範囲](#2-tfstateが記録する範囲)
3. [terraform planの差分比較の仕組み](#3-terraform-planの差分比較の仕組み)
4. [「認識の不可視性」という軸](#4-認識の不可視性という軸)
5. [まとめ](#5-まとめ)
6. [次回予告](#6-次回予告)
7. [連載一覧：「AnsibleとTerraformの連携が壊れる理由はライフサイクルにあった」](#7-連載一覧ansibleとterraformの連携が壊れる理由はライフサイクルにあった)

---

## 1. はじめに

「Ansibleでコンテナ内部の設定を変更しても、Terraformがそれに気づかないのは、何らかの見落としがあるからだ」と考えていないでしょうか。

**[第40回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part4/ansible-terraform-part4-40/)** では、第31回から第39回で扱ってきた個々の改善を、手動実行から自動収束に至るLevel 1〜4の成熟度として整理しました。そのうえで、Level 4に到達しても、TerraformとAnsibleがそれぞれ自分の管理範囲しか見ていないという構造上のギャップは解消されないことを確認し、第4部（改善、CI/CD自動化編）を締めくくりました。

第5部（Terraformライフサイクル破壊編）は、このギャップそのものを主題に据えます。ここまでの第4部が「どう自動化し、どう改善するか」を扱ってきたのに対し、第5部は、TerraformのState管理そのものが持つ構造的な限界に踏み込みます。第41回となる今回は、その起点として、このギャップの正体をTerraformのState管理の仕組みから整理します。

正確に言うと、**Terraformは何かを見落としているのではなく、そもそもコンテナ内部のOSレイヤーを観測対象に含めていません**。この回で扱う問いは、「tfstateは何を記録し、何を記録しないのか、そしてその境界線はどこで決まるのか」です。

次のセクションでは、この境界線の一方の側、tfstateが記録する範囲を整理します。

---

[↑ 目次に戻る](#-目次)

---

## 2. tfstateが記録する範囲

Terraformが管理する情報の範囲を、tfstateの中身そのものから確認します。

**[第11回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part2/ansible-terraform-part2-11/)** では、コンテナ内部に手動でファイルを作成したうえで`terraform plan`を実行し、「No changes」と出力されることを確認しました。これは、`terraform plan`という差分比較の挙動を通じて、Terraformがコンテナ内部の変更を検知しないという事実を外側から確認したものです。この回では視点を変え、`terraform show`によってtfstateの中身そのものを直接開き、Terraformが何を属性として記録しているのかを構造から確認します。「検知されない」という現象の理由を、tfstateのデータ構造そのものから裏付けます。

### ■ 検証内容：`terraform show`によるtfstateの記録内容の確認

**実行コマンド**

```plaintext
terraform show
```

target-node1に対応する`docker_container.targets["target-node1"]`の部分を確認します。

**▼ 実行結果**

```plaintext
# docker_container.targets["target-node1"]:
resource "docker_container" "targets" {
    attach                                      = false
    bridge                                      = null
    command                                     = [
        "/usr/sbin/sshd",
        "-D",
    ]
    container_read_refresh_timeout_milliseconds = 15000
    cpu_set                                     = null
    cpu_shares                                  = 0
    domainname                                  = null
    entrypoint                                  = []
    env                                         = []
    hostname                                    = "4b64570ba7c4"
    id                                          = "4b64570ba7c44929aa21c195ea306c2020b1381dc5397f2c655aa5b2eb0256e1"
    image                                       = "sha256:32ab5c4e8d486ce8c1c2437c66cd22ad3d90048329efe06897302d2ac49c6456"
    init                                        = false
    ipc_mode                                    = "private"
    log_driver                                  = "json-file"
    logs                                        = false
    max_retry_count                             = 0
    memory                                      = 0
    memory_swap                                 = 0
    must_run                                    = true
    name                                        = "target-node1"
    network_data                                = [
        {
            gateway                   = "172.20.0.1"
            global_ipv6_address       = null
            global_ipv6_prefix_length = 0
            ip_address                = "172.20.0.4"
            ip_prefix_length          = 24
            ipv6_gateway              = null
            mac_address               = "b6:5a:28:a9:59:9d"
            network_name              = "ansible-lab-net"
        },
    ]
    network_mode                                = "bridge"
    pid_mode                                    = null
    privileged                                  = false
    publish_all_ports                           = false
    read_only                                   = false
    remove_volumes                              = true
    restart                                     = "no"
    rm                                          = false
    runtime                                     = "runc"
    security_opts                               = []
    shm_size                                    = 64
    start                                       = true
    stdin_open                                  = false
    stop_signal                                 = null
    stop_timeout                                = 0
    tty                                         = false
    user                                        = null
    userns_mode                                 = null
    wait                                        = false
    wait_timeout                                = 60
    working_dir                                 = null

    networks_advanced {
        aliases      = []
        ipv4_address = null
        ipv6_address = null
        name         = "ansible-lab-net"
    }

    ports {
        external = 2231
        internal = 22
        ip       = "0.0.0.0"
        protocol = "tcp"
    }

    （途中省略：uploadブロック以降、環境固有の内容のため）
}
```

（途中省略：target-node2・target-node3の`docker_container.targets`、`docker_network.app_net`・`docker_network.lab_net`、`local_file.ansible_inventory`・`local_file.group_vars_target_nodes`・`local_file.private_key`、`null_resource.fix_permission`・`null_resource.provision`、`tls_private_key.generated`、各モジュールの`docker_image.this`が同様に出力される）

### ■ 結果

`docker_container.targets["target-node1"]`に記録されている属性を確認すると、`image`（使用イメージのハッシュ値）、`network_data`（IPアドレス、ゲートウェイ、MACアドレス、接続先ネットワーク名）、`ports`（外部公開ポートと内部ポートの対応）といった属性が並んでいます。

この一覧の中に、コンテナ内部にインストールされているパッケージの一覧、稼働中のプロセス、あるいはコンテナ内部の任意のファイルの状態を示す属性は存在しません。tfstateの構造は、HCLコードのリソースブロックに書かれた引数に対応する属性の集合であり、そこに定義されていない情報は、そもそも記録する場所自体がありません。

**[第11回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part2/ansible-terraform-part2-11/)** で確認した「`terraform plan`が手動変更を検知しない」という現象は、この構造から導かれる結果です。`terraform plan`は、tfstateに記録された属性と現在の値を比較する処理であり、比較対象となる属性がそもそも存在しなければ、比較のしようがありません。次のセクションでは、この比較の仕組み自体を扱います。


---

[↑ 目次に戻る](#-目次)

---

## 3. terraform planの差分比較の仕組み

`terraform plan`が何と何を比較しているのかを、2つの対照的な変更を通じて確認します。

**[第11回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part2/ansible-terraform-part2-11/)** では、コンテナ内部への手動変更が`terraform plan`で検知されないことを確認しました。**[セクション2](#2-tfstateが記録する範囲)** では、tfstateがリソース属性の集合であり、コンテナ内部の状態を記録する場所自体がないことを構造から確認しました。この回では、tfstate管理対象外の変更と、tfstate管理対象の変更を対照させ、`terraform plan`という差分比較そのものが何を見て、何を見ていないのかを実機で確認します。

### ■ 検証内容：tfstate管理対象外の変更に対する`terraform plan`の挙動

**[セクション2](#2-tfstateが記録する範囲)** で確認した通り、`docker_container.targets["target-node1"]`のtfstate上の属性には、イメージやポートといったリソース属性が記録されている一方、コンテナ内部のファイルシステムの状態を示す項目は存在しません。この構造が実際に`terraform plan`の挙動にどう表れるかを確かめるため、target-node1のコンテナ内部に、tfstateが管理していないファイルを意図的に作成し、`terraform plan`を実行してこの変更が検知されるかどうかを確認します。

**実行コマンド**

```plaintext
docker exec -it target-node1 bash -c "echo 'manual change' > /tmp/manual_test.txt"
```

ファイルを作成後、`terraform plan`コマンドを実行します。

**実行コマンド**

```plaintext
terraform plan
```

**▼ 実行結果**

```plaintext
（途中省略：Refreshing state...によるリソース一覧の出力）

No changes. Your infrastructure matches the configuration.

Terraform has compared your real infrastructure against your configuration and found no differences, so no changes are needed.
```

コンテナ内部にファイルを作成したにもかかわらず、`terraform plan`は「No changes」と出力しました。比較対象となる属性が存在しない以上、`terraform plan`にとってこの変更は、比較の土俵に上がることすらないということになります。


### ■ 検証内容：tfstate管理対象の変更に対する`terraform plan`の挙動

続いて、`docker_container`リソースがtfstateで管理している属性のひとつである`restart`（再起動ポリシー）を、Terraformを経由せずDocker側から直接変更します。

`main.tf`の`docker_container`リソースブロック（81〜106行目）を確認すると、`restart`という属性は明示的に指定されていません。

```hcl
resource "docker_container" "targets" {
  for_each = local.target_nodes
  name     = each.key
  image    = module.image_ansible_target.image_id
  dynamic "networks_advanced" {
    for_each = local.target_node_networks[each.key]
    content {
      name = networks_advanced.value
    }
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

`restart`をHCLコード側で明示的に指定していないため、tfstate上はプロバイダーのデフォルト値である`"no"`（再起動しない）が記録されています。**[セクション2](#2-tfstateが記録する範囲)** の`terraform show`でもこの値を確認済みです。この状態で、HCLコード側を一切変更せず、Docker側から直接この属性を書き換えます。

**実行コマンド**

```plaintext
docker update --restart=always target-node1
```

**実行コマンド（変更確認）**

```plaintext
docker inspect target-node1 --format '{{.HostConfig.RestartPolicy.Name}}'
```

**▼ 実行結果**

```plaintext
always
```

Docker側では`restart`が`always`に変わりましたが、`main.tf`のHCLコードは何も変更していません。この状態で`terraform plan`を実行します。

**実行コマンド**

```plaintext
terraform plan
```

**▼ 実行結果**

```plaintext
（途中省略：Refreshing state...によるリソース一覧の出力）

Terraform used the selected providers to generate the following execution plan. Resource actions are indicated with the following symbols:
  ~ update in-place

Terraform will perform the following actions:

  # docker_container.targets["target-node1"] will be updated in-place
  ~ resource "docker_container" "targets" {
        id                                          = "4b64570ba7c44929aa21c195ea306c2020b1381dc5397f2c655aa5b2eb0256e1"
        name                                        = "target-node1"
      ~ restart                                     = "always" -> "no"
        # (48 unchanged attributes hidden)

        # (4 unchanged blocks hidden)
    }

Plan: 0 to add, 1 to change, 0 to destroy.

────────────────────────────────────────────────────────────────────────────────────────────── ──────────────────────────────────────────────────────────────────────────────────────────────

Note: You didn't use the -out option to save this plan, so Terraform can't guarantee to take exactly these actions if you run "terraform apply" now.
```

今度は`restart`属性について、`"always"`から`"no"`への変更が明確に差分として検出されました。`"always"`はDocker側から直接変更した現在の値、`"no"`はHCLコード側の定義（未指定によるデフォルト値）に基づいてTerraformが本来あるべきとする値です。`terraform plan`は、tfstateと現在の実際の値、そしてHCLコード側の定義を突き合わせ、一致していないことを差分として報告しています。

### ■ 結果

2つの検証結果を対比すると、`terraform plan`が何を比較しているかが明確になります。
```

【tfstate管理対象外の変更（コンテナ内部のファイル）】  
比較対象となる属性が存在しない  
　→ 差分として検出されない（No changes）

【tfstate管理対象の変更（（例）restart属性）】  
HCLコード側に定義（または未指定によるデフォルト値）がある属性  
　→ 現在の値とHCLコード側の定義を比較し、差分として検出される

```

`terraform plan`は、tfstateに記録された属性とHCLコード側の定義、そしてプロバイダーAPIから取得した現在のリソース属性を比較する処理です。この処理は、コンテナ内部にSSHやDocker execで入って状態を確認するような処理を一切行っていません。**[第11回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part2/ansible-terraform-part2-11/)** で確認した「検知できる変更・できない変更」という現象は、この比較の仕組み自体から導かれる、当然の帰結です。

次のセクションでは、この比較の仕組みを踏まえたうえで、この構造を「認識の不可視性」という軸として整理します。


---

[↑ 目次に戻る](#-目次)

---

## 4. 「認識の不可視性」という軸

**[セクション2](#2-tfstateが記録する範囲)** ・**[3](#3-terraform-planの差分比較の仕組み)** で確認した構造を、この回全体の軸として整理します。

ここまでの検証結果を、「Terraformは何かを見落としている」という言い方でまとめたくなるかもしれません。しかし、この表現は正確ではありません。「見落とし」という言葉は、Terraformが本来検知できるはずの変更を、何らかの理由で取りこぼしている、という含みを持ちます。**[セクション2](#2-tfstateが記録する範囲)** ・**[3](#3-terraform-planの差分比較の仕組み)** で確認したのは、そうした取りこぼしではなく、tfstateという構造そのものが、コンテナ内部のOSレイヤーの状態を観測対象に含めていないという事実です。以降このシリーズでは、この構造を「認識の不可視性」と呼びます。

TerraformはAnsibleの変更を見ていないし、Ansibleの側もTerraformが管理する属性を意識せずに動作します。両者は、互いの存在を認識しないまま、それぞれの管理範囲の中で独立に動いています。**[第11回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part2/ansible-terraform-part2-11/)** ・**[第37回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part4/ansible-terraform-part4-37/)** で確認したように、Ansibleが SSH経由でコンテナ内部のファイルやサービスの状態を変更しても、`terraform plan`がこれを検知しないのは、Terraformの検知漏れではなく、そもそも比較の対象になっていないためです。「見落とし」と「観測対象に含まれていない」は、検知されないという結果は同じでも、原因が異なります。前者はTerraformの検知機能の不備を示唆しますが、後者は、TerraformとAnsibleがそれぞれ異なる管理範囲を持つツールであるという、設計上の役割分担そのものを示しています。

この不可視性自体は、通常運用では実害を生みません。AnsibleがコンテナのOSレイヤーに加える変更と、Terraformが管理するコンテナのリソース属性は、互いに独立した領域である限り、特に問題なく共存します。target-node1〜3の運用でこれまで確認してきた通り、Ansibleがファイルを配置しようが、パッケージをインストールしようが、Terraform側のtfstateには一切影響がありませんでした。逆にTerraformがコンテナを起動、破棄しても、それによってAnsibleの実行結果が書き換わることもありません。それぞれが自分の管理範囲の中で完結している限り、この不可視性は単なる役割分担であり、問題として意識される場面はありません。

ただし、この不可視性が無害でいられるのは、Terraformが管理するリソースが、作成された状態のまま存在し続けている間に限られます。**[第31回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part4/ansible-terraform-part4-31/)** の疎結合設計も、**[第34回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part4/ansible-terraform-part4-34/)** のTestinfraも、**[第37回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part4/ansible-terraform-part4-37/)** の定期検知も、コンテナが稼働し続けることを前提に機能していました。コンテナが存在し続ける限り、Ansibleが投じた設定はコンテナ内部に残り続けるため、疎結合にして後から検証する、定期的に検知して収束させるといったアプローチが成立します。

問題が生じるのは、この前提が崩れたとき、つまりTerraformの`lifecycle`ブロックによる強制再生成や`prevent_destroy`等の**ライフサイクル制御**によって、リソースそのものが破棄、再生成されるときです。
```

【通常運用】  
Terraformの管理範囲とAnsibleの管理範囲が、互いに認識しないまま独立して共存する  
　→ リソースが存在し続ける限り、不可視性があっても実害はない

【ライフサイクル制御が絡む場合】  
Terraformがリソースを強制的に破棄、再生成する  
　→ Ansibleが投じた設定は、Terraformの認識範囲外にあったため、  
　　保護も引き継ぎもされずに消失する

```

コンテナが破棄、再生成されるとき、Terraformが引き継ごうとするのは、tfstateに記録されている属性だけです。Ansibleが投じたファイルやパッケージ、サービスの設定は、そもそもtfstateに記録されていないため、引き継ぐ対象としても、保護する対象としても認識されません。通常運用では無害だったはずの不可視性が、リソースの破棄、再生成という操作をきっかけに、設定の消失という具体的な事象として表面化します。

ここでは、`create_before_destroy`や`replace_triggered_by`といった具体的なlifecycle設定の文法、挙動には踏み込みません。詳細は **[第42回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part5/ansible-terraform-part5-42/)** 以降で扱います。この回で押さえておきたいのは、「認識していない」という状態が、ある操作をきっかけに「保護されない」という状態に転じる、という構造そのものです。

次のセクションでは、この回で整理した内容をまとめます。


---

[↑ 目次に戻る](#-目次)

---

## 5. まとめ

この回で整理した内容を確認します。

* `terraform show`によるtfstateの中身の確認を通じて、Terraformが記録するのはイメージ、ポート、`restart`といったリソース属性のみであり、コンテナ内部のファイルシステムの状態を示す項目は存在しないことを実機で確認した
* `terraform plan`は、tfstateに記録された属性、HCLコード側の定義、プロバイダーAPIから取得した現在の値を比較する処理であり、コンテナ内部のファイル作成のような変更は比較の対象にすら上がらない一方、`restart`のようなtfstate管理対象の属性への変更は明確に差分として検出されることを、対照的な2つの検証で確認した
* Ansibleがコンテナ内部に加える変更が`terraform plan`で検知されないのは、Terraformの検知漏れではなく、tfstateという構造そのものがコンテナ内部のOSレイヤーの状態を観測対象に含めていないためである。「見落とし」ではなく「観測対象に含まれていない」という表現が正確である
* この不可視性は、Terraformが管理するリソースが存在し続けている通常運用では実害を生まない。**[第31回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part4/ansible-terraform-part4-31/)** の疎結合設計、**[第34回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part4/ansible-terraform-part4-34/)** のTestinfra、**[第37回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part4/ansible-terraform-part4-37/)** の定期検知は、いずれもこの前提のもとで機能してきた
* この前提は、`lifecycle`ブロックによる強制再生成のような、Terraformがリソースを破棄、再生成する操作によって崩れる。Ansibleが投じた設定はtfstateに記録されていないため、引き継がれることも保護されることもなく、通常運用では無害だった不可視性が、設定の消失という具体的な事象として表面化する

---

[↑ 目次に戻る](#-目次)

---

## 6. 次回予告

第41回となる今回は、第5部（Terraformライフサイクル破壊編）の起点として、TerraformのState管理メカニズムを整理しました。`terraform show`によるtfstateの記録内容の確認、`terraform plan`による2つの対照的な変更の検証を通じて、Terraformが管理するのはリソース属性のみであり、コンテナ内部のOS状態はそもそも観測対象に含まれていないことを実機で確認しました。そのうえで、この構造を「認識の不可視性」という軸として整理し、この不可視性が通常運用では無害である一方、ライフサイクル制御と組み合わさることで「破壊」という形で表面化する、という第5部全体の見通しを示しました。

次回は、この不可視性が実際に「破壊」として表面化する最初の具体例を扱います。`create_before_destroy`や`replace_triggered_by`によってリソースが強制的に再生成された際、Ansibleが投じた設定がどのように消し飛ぶかを実機で再現します。

**[次回：第42回：`create_before_destroy`や`replace_triggered_by`による強制再生成](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part5/ansible-terraform-part5-42/)**

---

📑 連載の移動　**[前の記事：【Ansible×Terraform編】第40回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part4/ansible-terraform-part4-40/)　｜　[次の記事：【Ansible×Terraform編】第42回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part5/ansible-terraform-part5-42/)**

---

> **🗺️ 初めての方、シリーズの全体像を知りたい方はこちら**
>
> シリーズ全体については、以下のまとめブログで整理しています。
>
> → **「AnsibleとTerraformの連携が壊れる理由はライフサイクルにあった」第5部まとめブログ：Terraformライフサイクル破壊編で明らかになった「認識の不可視性」の構造** **※近日公開予定**

---

[↑ 目次に戻る](#-目次)

---

## 7. 連載一覧：「AnsibleとTerraformの連携が壊れる理由はライフサイクルにあった」

### 第5部：Terraformライフサイクル破壊編

|回数|テーマ、記事タイトル|概要|
|---|---|---|
|**[第41回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part5/ansible-terraform-part5-41/)**|なぜTerraformはAnsibleが投じた設定を知らないのか|TerraformのState管理メカニズムと、Ansibleが変更するコンテナ内部状態の「認識の不可視性」を解剖する根本解説回。|
|**[第42回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part5/ansible-terraform-part5-42/)**|`create_before_destroy`や`replace_triggered_by`による強制再生成|HCLのライフサイクル制御（`lifecycle`ブロック）によって強制再生成（ForceNew）が発生し、Ansibleの設定が消し飛ぶ現象の再現。|
|**[第43回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part5/ansible-terraform-part5-43/)**|`prevent_destroy`設定時におけるAnsibleプロビジョニングの詰まり|誤破壊防止の`prevent_destroy`と、Ansibleの再実行（再プロビジョニング）要求がバッティングしてデプロイが詰まる障害。|
|**[第44回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part5/ansible-terraform-part5-44/)**|リソース再生成に伴うAnsible生成データの全喪失（データ消失障害）|Terraform側がリソースを破棄、再生成（Destroy & Create）した際、Ansibleで作成したデータベースやファイルなどの状態が全消去される問題。|
|**[第45回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part5/ansible-terraform-part5-45/)**|ネットワークや依存リソースの変更に引きずられる連鎖的再生成|依存関係にあるネットワーク（Docker Network）や上位リソースの変更により、ターゲット全体が連鎖破壊される現象。|
|**[第46回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part5/ansible-terraform-part5-46/)**|プロビジョニング途中の接続切断とState不整合（ハーフデプロイ状態）|Ansible実行中に接続が切断、エラー停止した際、TerraformのStateが「作成完了」と「プロビジョニング未完了」の半端な状態になる問題。|
|**[第47回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part5/ansible-terraform-part5-47/)**|ステートフルなデータ（Volume/DB）を保持しながらの安全な再構築|内部データをDocker Volumeに分離し、コンテナ（リソース）が再生成されてもAnsibleの投入データを生かす設計。|
|**[第48回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part5/ansible-terraform-part5-48/)**|イミュータブルインフラストラクチャにおけるAnsibleの限定的役割|「実行時にAnsibleで設定する」のを取りやめ、ビルド時にAnsibleを組み込んでコンテナイメージを焼き込む運用へのシフト。|
|**[第49回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part5/ansible-terraform-part5-49/)**|CI/CD環境において再構築事故を物理的に防ぐパイプラインガード|GitHub Actions等で誤ってDestroy & Createが走らないよう、`terraform plan`の差分ログを解析して自動ブロックするガードレール設計。|
|**[第50回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part5/ansible-terraform-part5-50/)**|連載総括：Ansible×Terraformを共存させる「ツール境界線」の設計原則|50回を通じた結論。「どこまでをTerraformに任せ、どこからをAnsibleに委ねるか」の境界線（アンチパターンと原則）のまとめ。|

---

[↑ 目次に戻る](#-目次)

---