---
title: '「AnsibleとTerraformの連携が壊れる理由はライフサイクルにあった」 第13回：コード修正に伴うリソースの強制再生成（リビルド）リスク'
description: 'TerraformのHCL定義変更が「更新」で済むケースと「破棄・再生成」になるケースを分ける判定構造を整理する。terraform planの出力からforce_new_resourceの発生を事前に読み取り、Ansibleが投入した内部データの消失リスクに備える設計方針を理解する。'
pubDate: '2026-08-19'
category: 'infra'
tags: ['Ansible', 'Terraform', 'force_new_resource', 'lifecycle', 'terraform plan']
seriesId: 'ansible-terraform-part2'
seriesNo: 13
prevPost: 'https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part2/ansible-terraform-part2-12/'
nextPost: 'https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part2/ansible-terraform-part2-14/'
relatedSeries: ''
---

<style> table th, table td { word-break: normal; } table td:first-child { white-space: nowrap; } </style>

> **🗺️ 初めての方・シリーズの全体像を知りたい方はこちら**
> 
> シリーズ全体については、以下のまとめブログで整理しています。
> 
> → **「AnsibleとTerraformの連携が壊れる理由はライフサイクルにあった」第2部まとめブログ： TerraformとAnsibleの運用で直面する構成ズレと状態管理の問題** **※近日公開予定**

---

## 📋 目次

1. [はじめに](#1-はじめに)
2. [更新で済むケースと再生成になるケースの違い](#2-更新で済むケースと再生成になるケースの違い)
3. [terraform planの出力による事前判定](#3-terraform-planの出力による事前判定)
4. [再生成時のAnsible設定消失パターン](#4-再生成時のansible設定消失パターン)
5. [再生成リスクを考慮したコード修正の設計方針](#5-再生成リスクを考慮したコード修正の設計方針)
6. [まとめ](#6-まとめ)
7. [次回予告](#7-次回予告)
8. [連載一覧：「AnsibleとTerraformの連携が壊れる理由はライフサイクルにあった」](#8-連載一覧ansibleとterraformの連携が壊れる理由はライフサイクルにあった)

---

## 1. はじめに

「コンテナイメージのタグを1つ書き換えただけなのに、コンテナが作り直されてAnsibleの設定が消えた」という経験はないでしょうか。

前回、**[第12回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part2/ansible-terraform-part2-12/)** では、初期化スクリプト・コンテナ起動定義の変更を起点に、Terraformがリソースを破棄、再生成し、Ansibleが投入したOS内部の設定が消失する連鎖構造を確認しました。その過程で、この破棄、再生成（`force_new_resource`）を引き起こす属性は、初期化スクリプトに相当するものだけに限らないことにも触れました。コンテナイメージの変更、ポートマッピングの変更、ネットワーク設定の変更といった属性も、同じように`force_new_resource`を引き起こし得ることを構造として整理しています。

今回扱うのは、この「初期化スクリプトに限らない」という部分をもう一段具体化する内容です。Terraformはリソース属性の変更に対して、常に同じ扱いをするわけではありません。ある属性の変更は「更新」として、リソースを壊さずにその場で反映されます。別の属性の変更は「破棄、再生成」として、リソースを一度壊してから作り直すという形で反映されます。この違いは、コードを書いている側からは見えにくく、`terraform apply`を実行して初めて結果として現れることが少なくありません。

具体的には、次のような場面です。

- ラベルの1行を書き換えたら`terraform plan`は`~`（更新）だった
- コンテナイメージのタグを1行書き換えたら`terraform plan`は`-/+`（破棄、再生成）だった
- 同じ「1行の変更」でも、属性によって結果が違う

この違いがどこから来るのか、そして`apply`を実行する前にこの違いをどう見分けるのかが、今回のテーマです。

この回では、「どのHCL定義変更が更新で済み、どの変更が破棄、再生成になるのか」という判定構造を軸に、内容を整理します。まず次のセクションで、この判定構造そのものの前提となる、更新と破棄、再生成という2つの処理の違いを確認します。

---

[↑ 目次に戻る](#-目次)

---

## 2. 更新で済むケースと再生成になるケースの違い

この回の前提となる、「更新」と「破棄、再生成」という2つの処理の違いを整理します。

Terraformはリソース属性の変更を検知した際、常に同じ方法でその変更を反映するわけではありません。反映の方法は、大きく分けて次の2種類です。

* **更新（in-place update）**：リソースを破棄せず、変更のあった属性だけをその場で書き換える。リソースそのものは存続するため、Ansibleが投入したOS内部の設定は保持される
* **破棄、再生成（force_new_resource）**：リソースを一度破棄し、新しい属性値で作り直す。リソースそのものが入れ替わるため、Ansibleが投入したOS内部の設定は消失する

**[第12回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part2/ansible-terraform-part2-12/)** で確認した`upload`ブロックの変更は、この2つのうち後者、破棄、再生成にあたるケースでした。

どちらの扱いになるかは、変更する属性の種類によって決まります。より正確に言うと、この判定はTerraform本体ではなく、**リソースプロバイダーの実装**によって決まります。プロバイダーが、ある属性について「稼働中のリソースに対してその場で書き換える手段」を実装していれば、その属性の変更は更新として反映されます。逆に、プロバイダー側にその手段が実装されていない、あるいはリソースの性質上その場での書き換えが不可能な属性については、プロバイダーはその変更を「更新不可」として扱い、破棄、再生成という形でしか反映できません。

`docker_container`リソースを例に、この2つの分かれ方を具体的に見ておきます。

再生成が発生しやすい属性変更の例として、以下が挙げられます。

* コンテナイメージの変更
* ポートマッピングの変更
* ネットワーク設定の変更

これらはいずれも、コンテナというリソースの根本的な構成要素です。稼働中のコンテナに対して「イメージだけ差し替える」「ポートだけ変更する」といった操作は、Dockerの仕組み上そもそも成立しません。そのため、これらの属性が変更された場合、Terraformは破棄、再生成という形でしか反映できません。

一方、更新で済む属性変更の例として、以下が挙げられます。

* 環境変数の変更
* ラベルの変更

これらは、コンテナを破棄しなくても反映できる、あるいはプロバイダーがその場での反映手段を実装している属性です。こうした属性の変更であれば、Terraformは更新としてリソースを扱い、コンテナは存続したまま、Ansibleが投入した設定にも影響は及びません。

ここで注意しておきたいのは、この分類がDockerプロバイダー固有のものではなく、他のプロバイダーでも同じ構造で存在するという点です。VM・クラウド環境では、例えばディスクサイズの変更やネットワーク設定の変更が、更新ではなく破棄、再生成として扱われることがあります。どの属性が更新で済み、どの属性が破棄、再生成になるかという具体的な組み合わせはプロバイダーごとに異なりますが、「属性ごとに更新可否があらかじめ決まっており、それに応じてTerraformの扱いが分かれる」という構造そのものは、プロバイダーを問わず共通しています。

この構造を踏まえると、コードを修正する側にとって重要なのは、個々の属性が更新可能かどうかを暗記することではなく、**変更を加える前に、その変更が更新になるのか破棄、再生成になるのかを確認する手段を持っておくこと**です。次のセクションでは、この確認を`apply`実行前に行うための、`terraform plan`の出力の読み方を整理します。

---

[↑ 目次に戻る](#-目次)

---

## 3. terraform planの出力による事前判定

前セクションで確認した通り、リソース属性の変更が更新になるか破棄、再生成になるかは、プロバイダーの実装によってあらかじめ決まっています。この判定は、コードを書いている時点では見えません。しかし、`terraform apply`を実行する前であれば、`terraform plan`の出力からこの判定結果を確認できます。

`terraform plan`の出力には、変更の種類を示す記号が含まれます。

```plaintext
~   : 更新（リソースは破棄されない）
-/+ : 破棄、再生成（リソースが破棄されAnsibleの設定が消失する）
```

この記号の意味を、実機で確認します。

### ■ 検証内容（ポートマッピングの変更が`terraform plan`で`-/+`として表示されることの確認）

検証には、`docker_container.targets`の`ports`ブロックを使用します。`external`の値は`locals`ブロックの`target_nodes`マップで定義されており、`target-node1`の値のみを変更します。

* **ファイル名：**`main.tf`

```hcl
locals {
  target_nodes = {
    "target-node1" = 2231
    "target-node2" = 2222
    "target-node3" = 2223
  }
}
```

`target-node1`の値のみを`2221`から`2231`に変更し、`target-node2`、`target-node3`には変更を加えていません。

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
      ~ hostname                                    = "c207933bacf2" -> (known after apply)
      ~ id                                          = "c207933bacf2af6824303c3d9f99155398618f4f89b6c3444ed0fd5436eacac6" -> (known after apply)
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
              - ip_address                = "172.20.0.4"
              - ip_prefix_length          = 24
              - mac_address               = "f6:a6:93:bf:4b:73"
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

      ~ ports {
          ~ external = 2221 -> 2231 # forces replacement
            # (3 unchanged attributes hidden)
        }

        # (3 unchanged blocks hidden)
    }

  # local_file.ansible_inventory must be replaced
-/+ resource "local_file" "ansible_inventory" {
      ~ content              = <<-EOT
            [target_nodes]
            target-node1 ansible_host=172.20.0.4 ansible_user=ansible
            target-node2 ansible_host=172.20.0.3 ansible_user=ansible
            target-node3 ansible_host=172.20.0.2 ansible_user=ansible
        EOT -> (known after apply) # forces replacement
        # (中略：content_base64sha256等のハッシュ値差分)
    }

Plan: 2 to add, 0 to change, 2 to destroy.

Changes to Outputs:
  ~ target_nodes_ips = {
      ~ target-node1 = "172.20.0.4" -> (known after apply)
        # (2 unchanged attributes hidden)
    }
```

出力の先頭には`# docker_container.targets["target-node1"] must be replaced`とあり、リソース全体の記号も`-/+`です。変更を加えたのは`target-node2`、`target-node3`ではなく`target-node1`のみであるため、`-/+`が付いているのも`target-node1`だけであり、他の2台には一切差分が出ていません。

再生成の根拠は、出力の中でピンポイントに示されています。

```plaintext
~ ports {
    ~ external = 2221 -> 2231 # forces replacement
      # (3 unchanged attributes hidden)
  }
```

`external`の値の変更行に`# forces replacement`という注記が付いており、この属性の変更が破棄、再生成を引き起こすことが明示されています。

一方、同じ出力の中には`- network_mode = "bridge" -> null`という表示もありますが、こちらには`forces replacement`の注記はありません。これは **[第11回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part2/ansible-terraform-part2-11/)** で`lifecycle.ignore_changes`の対象にした属性であり、**[第12回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part2/ansible-terraform-part2-12/)** の`upload`ブロック変更時と同じ構造で、再生成の引き金になった属性とそうでない属性が、出力上明確に区別されています。

なお、`docker_container.targets`に連動する形で`local_file.ansible_inventory`も`must be replaced`となっています。`target-node1`のIPアドレスが再生成によって変わる可能性があるため、インベントリファイルの内容もあわせて再生成対象になっています。

`Plan: 2 to add, 0 to change, 2 to destroy`という表示も、更新（`0 to change`）ではなく、追加と破棄という組み合わせでこの変更が扱われることを裏付けています。

### ■ 結果

この検証から、`terraform plan`の出力にある`-/+`という記号と`# forces replacement`という注記が、破棄、再生成の発生を`apply`前に予告する役割を果たしていることが確認できました。`external`という1つの属性の変更が、コンテナ全体、さらには関連する`local_file`リソースにまで再生成を波及させる様子が、`apply`を実行する前の時点で読み取れます。

この`-/+`が表示されている場合、`apply`を実行すればリソースが破棄されることが事前に分かります。次のセクションでは、この破棄が実際に発生した後、Ansibleが投入した設定に何が起きるかを、引き続き実機で確認します。

---

[↑ 目次に戻る](#-目次)

---

## 4. 再生成時のAnsible設定消失パターン

前セクションでは、`terraform plan`の出力から、破棄、再生成が発生することを`apply`前に確認できることを見ました。このセクションでは、実際に`apply`を実行し、破棄、再生成が発生した後、Ansibleが投入した設定に何が起きるかを確認します。

### ■ 検証内容（ポートマッピングの変更による再生成が、Ansible管理下のファイルと初期化処理管理下のファイルにそれぞれどう影響するかの確認）

前セクションの`terraform plan`を実行した状態から、`terraform apply`を実行します。

**実行コマンド**

```
terraform apply
```

`yes`で承認すると、target-node1のみが破棄、再生成されました。

**▼ 実行結果**

```
Do you want to perform these actions?
  Terraform will perform the actions described above.
  Only 'yes' will be accepted to approve.

  Enter a value: yes

local_file.ansible_inventory: Destroying... [id=733afaba17b50383acf6b02a681a2bf4379feed0]
local_file.ansible_inventory: Destruction complete after 0s
docker_container.targets["target-node1"]: Destroying... [id=c207933bacf2af6824303c3d9f99155398618f4f89b6c3444ed0fd5436eacac6]
docker_container.targets["target-node1"]: Destruction complete after 2s
docker_container.targets["target-node1"]: Creating...
docker_container.targets["target-node1"]: Creation complete after 1s [id=39cd5018935f622b17c7e704867a703fda6650c806403e54e4f3c27c84f9d616]
local_file.ansible_inventory: Creating...
local_file.ansible_inventory: Creation complete after 0s [id=733afaba17b50383acf6b02a681a2bf4379feed0]

Apply complete! Resources: 2 added, 0 changed, 2 destroyed.

Outputs:

target_nodes_ips = {
  "target-node1" = "172.20.0.4"
  "target-node2" = "172.20.0.3"
  "target-node3" = "172.20.0.2"
}
```

target-node1のみが新しいコンテナとして再生成されました。前セクションで`target-node1`のみに変更を加えたため、`target-node2`、`target-node3`はログにも一切登場していません。

IPアドレスに注目すると、`target-node1`は再生成後も`172.20.0.4`のままで変わっていません。**[第12回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part2/ansible-terraform-part2-12/)** では3台同時に再生成した結果、解放されたIPアドレスが別のノードに割り当てられる形で入れ替わりが発生していましたが、今回は1台のみの再生成であるため、解放されたIPアドレスをそのコンテナ自身がそのまま再取得しています。IPアドレスが変わるかどうかは、再生成のタイミングで他にどのリソースが動いているかに左右されるという点が、ここから読み取れます。

再生成されたtarget-node1で、Ansible管理下の`/etc/app.conf`と、初期化処理管理下の`/etc/init_marker`をそれぞれ確認します。

**実行コマンド**

```
docker exec -it target-node1 cat /etc/app.conf
```

**▼ 実行結果**

```
cat: /etc/app.conf: No such file or directory
```

Ansibleが投入したはずの`/etc/app.conf`が存在しなくなっています。

**実行コマンド**

```
docker exec -it target-node1 cat /etc/init_marker
```

**▼ 実行結果**

```
init_version=v1
```

一方、初期化処理が書き込んだ`/etc/init_marker`は、再生成後のコンテナにもそのまま存在しています。

### ■ 結果

この検証から、ポートマッピングという、初期化スクリプトとは無関係の属性変更であっても、破棄、再生成が発生すれば、**[第12回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part2/ansible-terraform-part2-12/)** で確認したのと同じ構造で、Ansibleが投入した設定が消失することが確認できました。消える対象がAnsible管理下の`/etc/app.conf`であり、初期化処理管理下の`/etc/init_marker`は影響を受けないという対比も、前回と同じです。

ここで整理しておきたいのは、Ansibleの設定が消えるかどうかを決めているのは、変更した属性が「初期化スクリプトに関係するかどうか」ではなく、**その属性変更がforce_new_resourceを引き起こすかどうか**という点です。今回変更したのはコンテナの起動定義や初期化処理とは無関係の`ports`ブロックでしたが、Dockerプロバイダーの実装ではこの属性が「更新不可」とされているため、破棄、再生成という扱いになり、結果としてAnsibleの設定も同じように消失しました。

リソースの内部にあるものは、破棄、再生成が発生した時点ですべて失われます。この消失は、初期化スクリプトの変更が引き金であっても、今回のようにポートマッピングの変更が引き金であっても、結果としては同じです。Ansibleを再実行しない限り、この状態は自動では復旧しません。

---

[↑ 目次に戻る](#-目次)

---

## 5. 再生成リスクを考慮したコード修正の設計方針

セクション2〜4で整理した内容を振り返ります。セクション3、4の実機検証では、Docker環境における`ports`属性の変更を具体例として取り上げましたが、「更新になるか破棄、再生成になるか」という判定そのものは、セクション2で整理した通りプロバイダーの実装によって決まる話であり、Docker特有の構造ではありません。AWS・GCPなど別のプロバイダーであっても、リソースごとにどの属性が更新可能でどの属性が更新不可（force_new_resource）なのかという同じ問いが存在します。したがって、ここから整理する設計方針も、Docker環境に限らず、コード修正を行うあらゆるプロバイダー環境に共通する内容として位置づけます。

### 変更前にterraform planで再生成の有無を確認する

コード修正を行った後は、`apply`を実行する前に必ず`terraform plan`を実行し、`-/+`の有無を確認する習慣を持つことが基本になります。セクション3で確認した通り、`-/+`が表示されているリソースには`# forces replacement`という注記が該当の属性変更行に付与されており、どの属性が再生成の引き金になっているかを`apply`前に読み取ることができます。この確認を省略し、`plan`の出力を見ないまま`apply`を実行すると、意図しないリソースの破棄、再生成に気づく機会を失います。

### 再生成が発生する場合はAnsibleの再実行をセットで計画する

`-/+`が確認された場合、その`apply`によってAnsibleが投入した設定が消失することは、セクション4で確認した通りです。この消失を前提とし、`apply`の実行とAnsibleの再実行を、1つの作業としてセットで計画しておく必要があります。

```
terraform planで「-/+」を確認する
　↓
terraform applyを実行する（リソースが再生成される）
　↓
ansible-playbookを再実行する（OS設定が復元される）
```

セクション4の検証では、この一連の流れのうち`apply`実行後の状態（`/etc/app.conf`が消失した状態）までを確認しました。この状態から`ansible-playbook`を再実行すれば、`/etc/app.conf`は再びdesired stateへ復帰します。重要なのは、この再実行が自動では行われないという点です。`apply`を実行した担当者が、この消失を認識し、Ansibleの再実行まで手順に含めておかない限り、OS設定が空白のまま運用が続くことになります。

### データの永続化が必要な場合は外部ストレージへの分離を検討する

リソース内部に保存されたデータは、セクション4で確認した通り、リソースの破棄、再生成の影響を直接受けます。Ansibleが再実行によって復元できるのは、Playbookが管理している設定やファイルに限られます。リソース内部でしか存在しないデータ、例えばアプリケーションが実行時に生成するデータなどは、Ansibleの再実行によって復元することはできません。

こうしたデータについては、リソース内部に置かず、外部ストレージへ分離するという設計が根本的な対応になります。この分離の実装をどう設計するかは、リソースのライフサイクルとデータの永続化を専門に扱う **[第47回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part5/ansible-terraform-part5-47/)** で扱う内容であり、この回ではこれ以上踏み込みません。

以上の3点は、いずれも「破棄、再生成はいつか起こり得るものである」という前提に立った備え方です。`force_new_resource`という仕組みそのものをコード修正でなくすことはできません。修正前の確認、修正後の運用手順、データ設計という3つの観点で備えておくことが、この回で整理した消失リスクへの現実的な対応になります。

---

[↑ 目次に戻る](#-目次)

---

## 6. まとめ

この回で整理した内容を確認します。

* TerraformのHCL定義変更が「更新」になるか「破棄、再生成」になるかは、リソースプロバイダーの実装によって決まる。稼働中のリソースに対してその場で反映できる属性は更新、反映できない属性は破棄、再生成として扱われる
* `terraform plan`の出力にある`~`は更新、`-/+`は破棄、再生成を意味する。`-/+`が表示されているリソースには、再生成の根拠となる属性変更行に`# forces replacement`という注記が付与されており、`apply`前にこの記号と注記を確認することで、再生成の発生を事前に把握できる
* 破棄、再生成が発生した時点で、リソース内部にあったAnsibleが投入したファイル、パッケージ、サービス設定、データはすべて消失する。今回はDocker環境のポートマッピングの変更を具体例として確認したが、この消失は初期化スクリプトに関係する属性変更に限らず、force_new_resourceを引き起こす属性であれば同じ構造で発生する
* コード修正前に`terraform plan`で再生成の有無を確認し、`-/+`が出た場合は`apply`とAnsibleの再実行をセットで計画する。リソース内部にしか存在しないデータについては、外部ストレージへの分離が根本的な対応になる

---

[↑ 目次に戻る](#-目次)

---

## 7. 次回予告

**[第12回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part2/ansible-terraform-part2-12/)** では、`terraform apply`という正規の操作そのものが、初期化スクリプト・コンテナ起動定義の変更を起点にAnsibleの設定を消失させる連鎖構造を整理しました。今回はその視点をさらに踏み込み、TerraformのHCL定義変更が「更新」で済むケースと「破棄、再生成」になるケースを分ける判定構造そのものを扱いました。`terraform plan`の出力にある`~`と`-/+`という記号、そして`# forces replacement`という注記が、この判定結果を`apply`前に示していること、Docker環境のポートマッピングの変更を具体例に、破棄、再生成が発生した際にAnsibleが投入した設定が消失する様子を確認しました。

次回は、この消失を復旧する側であるAnsible Playbookに焦点を移します。今回整理した通り、再生成が発生した後はAnsibleの再実行によってOS設定を復元する運用が前提になりますが、この再実行そのものが安全に行えるかどうかは、Playbookの冪等性設計にかかっています。1回目の実行は成功しても、2回目以降の実行でファイルの重複やサービスの重複起動といった問題が起きれば、この復旧作業自体が新たなトラブルの原因になります。

**[次回：第14回：複数回実行時におけるAnsible Playbookの冪等性の確保](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part2/ansible-terraform-part2-14/)**

---

📑 連載の移動　**[前の記事：【Ansible×Terraform編】第12回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part2/ansible-terraform-part2-12/)　｜　[次の記事：【Ansible×Terraform編】第14回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part2/ansible-terraform-part2-14/)**

---

> **🗺️ 初めての方・シリーズの全体像を知りたい方はこちら**
> 
> シリーズ全体については、以下のまとめブログで整理しています。
> 
> → **「AnsibleとTerraformの連携が壊れる理由はライフサイクルにあった」第2部まとめブログ： TerraformとAnsibleの運用で直面する構成ズレと状態管理の問題** **※近日公開予定**

---

[↑ 目次に戻る](#-目次)

---

## 8. 連載一覧：「AnsibleとTerraformの連携が壊れる理由はライフサイクルにあった」

### 第2部：運用・ライフサイクル編

|回数|テーマ・記事タイトル|概要|
|---|---|---|
|**[第11回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part2/ansible-terraform-part2-11/)**|手動変更による構成ドリフトの検知と同期手法|構築後に手動やAnsibleで変更したOS内部の状態を、Terraformの`plan`が検知できず、インフラの管理状態に不整合が出る問題。ドリフトシリーズとの接続を示す。|
|**[第12回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part2/ansible-terraform-part2-12/)**|`terraform apply`実行時における初期化処理とOS設定の上書き問題|Terraform側で初期化スクリプトやコンテナ起動定義を書き換えて再実行した際、Ansibleによって設定済みのOS内部状態が初期化される課題。|
|**[第13回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part2/ansible-terraform-part2-13/)**|コード修正に伴うリソースの強制再生成（リビルド）リスク|TerraformのHCL定義変更によって、リソースが「更新」ではなく「破棄、再生成」され、Ansibleが投入した内部データが消失する課題。|
|**[第14回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part2/ansible-terraform-part2-14/)**|複数回実行時におけるAnsible Playbookの冪等性の確保|1回目の実行は成功するものの、2回目（運用フェーズ）の実行時に「ファイル重複」や「サービス重複起動」等でAnsibleが停止する問題。冪等性シリーズ、レガシーPlaybook引き継ぎの知識を実践に適用する回として位置づける。|
|**[第15回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part2/ansible-terraform-part2-15/)**|チーム運用における状態管理ファイル（tfstate）の整合性維持|Ansibleを実行するオペレーターと、Terraformを管理するエンジニア間で、Terraformの状態管理ファイルに競合が発生するリスク。チーム運用での役割分担設計も整理する。|
|**第16回**(https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part2/ansible-terraform-part2-16/)|パッケージアップデートに伴う環境の非互換性への対応|運用中に`apt update`等を実行した結果、OSのライブラリやミドルウェアのバージョンが上がり、Terraformの定義と矛盾が生じるケース。|
|第17回|リソース再生成時におけるIPアドレス変動と接続情報の更新遅延|リソース（コンテナ/VM）の再生成に伴ってIPアドレスが変更された際、Ansible用のインベントリや各種設定ファイルの書き換えが追いつかない問題。|
|第18回|TerraformとAnsible Vaultにおける機密情報の役割分担|データベースのパスワードやAPIキーなどの機密情報を、両ツールのどちらで暗号化し、どのように管理すべきかの運用設計。Vault誤用パターンと回避策も整理する。|
|第19回|OSのメジャーバージョンアップ時におけるPlaybookの互換性検証|Terraform側でベースイメージ（例：Ubuntu 22.04→24.04）を変更した際、Ansibleの古い独自モジュールやシェルコマンドが機能しなくなる課題。|
|第20回|運用編まとめ：ミュータブル運用とイミュータブル運用の折衷案|状態（データ）を維持し続ける運用（ミュータブル）と、使い捨てる運用（イミュータブル）を、両ツールの組み合わせでどのように着地させるかの最適解。|

---

[↑ 目次に戻る](#-目次)

---
