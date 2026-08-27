---
title: '「AnsibleとTerraformの連携が壊れる理由はライフサイクルにあった」 第25回：構文チェックツール（HCL構文、ansible-lint）の競合緩和'
description: 'Terraformのtemplatefile関数でAnsibleのインベントリ・変数ファイルを動的生成する構成において、HCL側の記法とansible-lintのルールが生成物を挟んで間接的に競合する構造を整理する。CI/CDパイプラインでの競合の現れ方、緩和のための設計パターンもあわせて扱う。'
pubDate: '2026-08-26'
category: 'infra'
tags: ['Ansible', 'Terraform', 'ansible-lint', 'terraform fmt', '静的解析', 'CI/CD']
seriesId: 'ansible-terraform-part3'
seriesNo: 25
prevPost: 'https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part3/ansible-terraform-part3-24/'
nextPost: 'https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part3/ansible-terraform-part3-26/'
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
2. [TerraformによるAnsible成果物の動的生成](#2-terraformによるansible成果物の動的生成)
3. [HCL側のテンプレート記法とYAML側の記法の非親和性](#3-hcl側のテンプレート記法とyaml側の記法の非親和性)
4. [ansible-lintが指摘するルールとの衝突](#4-ansible-lintが指摘するルールとの衝突)
5. [CI/CDパイプラインでの競合の現れ方](#5-cicdパイプラインでの競合の現れ方)
6. [緩和のための設計パターン](#6-緩和のための設計パターン)
7. [まとめ](#7-まとめ)
8. [次回予告](#8-次回予告)
9. [連載一覧：「AnsibleとTerraformの連携が壊れる理由はライフサイクルにあった」](#9-連載一覧ansibleとterraformの連携が壊れる理由はライフサイクルにあった)

---

## 1. はじめに

「HCLの構文チェックとansible-lintは、別々のファイルを見ているのだから競合しないはずだ」と考えたことはないでしょうか。

**[第21回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part3/ansible-terraform-part3-21/)** から **[第24回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part3/ansible-terraform-part3-24/)** までは、いずれも実行時、つまり`apply`時や実行後に顕在化する問題を扱ってきました。ネストされたエラーログの解析、マルチネットワーク環境での接続エラー、SSHタイムアウト、ホスト側のリソース枯渇と、扱う対象は変わっても、共通していたのは「実行してみて初めて分かる問題」だったという点です。

**[第25回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part3/ansible-terraform-part3-25/)** となる今回は視点を変えます。実行する前、静的解析の段階で発生する問題です。

TerraformにはHCLの記述ルールを整える`terraform fmt`があり、AnsibleにはPlaybookの設計品質を静的にチェックする`ansible-lint`があります。両者は別々の言語（HCLとYAML）、別々のファイルを対象にしているため、一見すると互いに干渉する余地はないように見えます。

しかし、Terraformの`templatefile`関数のように、HCL側でAnsibleの成果物（インベントリファイルや変数ファイル）を動的に生成する構成を取ると、この前提が崩れます。生成物はYAML/INIファイルとしてansible-lintの対象になる一方、その生成元はHCLのテンプレート構文で書かれています。この回で扱う問いは、「生成元と生成物、どちらの基準に合わせて書けばよいのか」です。

次のセクションでは、この問いの前提となる、TerraformによるAnsible成果物の動的生成という構成そのものを整理します。

---

[↑ 目次に戻る](#-目次)

---

## 2. TerraformによるAnsible成果物の動的生成

この回で扱う構成の前提を整理します。Terraformの`templatefile`関数を使うと、Terraformが管理する値（コンテナのIPアドレス等）を埋め込んだAnsibleのインベントリファイルを動的生成できます。

* **ファイル名：`main.tf`（該当箇所）**

```hcl
resource "local_file" "ansible_inventory" {
  filename = "${path.module}/inventory.ini"
  content = templatefile("${path.module}/inventory.tftpl", {
    ips = {
      for name, container in docker_container.targets :
      name => container.network_data[0].ip_address
    }
  })
}
```

`content`には、`docker_container.targets`から各ノード名とIPアドレスを取り出したマップ（`ips`）を、`inventory.tftpl`というテンプレートファイルに渡した結果が入ります。

* **ファイル名：`inventory.tftpl`**
```
[target_nodes]
%{ for name, ip in ips ~}
${name} ansible_host=${ip} ansible_user=ansible
%{ endfor ~}
```

`%{ for }`〜`%{ endfor }`はHCLのテンプレート制御構文です。`ips`マップをループしながら、`${name} ansible_host=${ip} ansible_user=ansible`という1行を、ノードの数だけ展開します。生成される`inventory.ini`はAnsibleが読み込むINI形式のファイルですが、その生成元である`inventory.tftpl`はHCLのテンプレート構文で書かれています。この二重構造が、今回扱う問題の前提になります。

### ■ 検証内容：templatefileによるインベントリ生成の確認

`terraform apply`を実行し、生成される`inventory.ini`の内容を確認します。

**実行コマンド**

```plaintext
terraform apply
```

**▼ 実行結果**
```plaintext
docker_network.lab_net: Refreshing state... [id=261d153c5dc82cf69950a9289c1726cbde2f5a14fa9b2f395c58434d13c4a354]
docker_image.ansible_target_legacy: Refreshing state... [id=sha256:6396f6e711cb1cce4aaec489d9944bcf5f3e19997cb94345e194da7ca1b62b5aansible-target:ubuntu18.04]
docker_image.ansible_target_deploy_nopasswd: Refreshing state... [id=sha256:fdb892d2ff6bdaefd48c7e674ee994458a883bea1680475802219359aa56b758ansible-target:deploy-nopasswd]
docker_network.app_net: Refreshing state... [id=54f7b73fd1625642a3ef6ed67fbde6f93062353422a9afeced223cd940c4c5ca]
docker_image.ansible_target_deploy_passwd: Refreshing state... [id=sha256:fdb892d2ff6bdaefd48c7e674ee994458a883bea1680475802219359aa56b758ansible-target:deploy-passwd]
docker_image.ansible_target: Refreshing state... [id=sha256:3557c4c7ab005be7a378a329a5ca402ec4ae742c0b158cf872f2efe01bdb4a30ansible-target:ubuntu22.04]
tls_private_key.generated: Refreshing state... [id=01fef040852c30c6b7e1ca3cc397456584b4d7e4]
local_file.private_key: Refreshing state... [id=7d11d7745c28bb12f23b6501732973a67553e3e1]
null_resource.fix_permission: Refreshing state... [id=4436755063213838558]
docker_container.targets["target-node2"]: Refreshing state... [id=a33463336b78be7e1b09cfef85e2b18e4cbdcdb4d7f43087e344e8fa6cb62743]
docker_container.targets["target-node3"]: Refreshing state... [id=acac4b63e617b41bcb7b9f7126a58bd49c20a9e8fa4d95bf9118c088b5306fcd]
docker_container.targets["target-node1"]: Refreshing state... [id=cd4aa4face014742f05dd5102d08c9c0145ff60d8c65af74d5547af38ac4d40e]
local_file.ansible_inventory: Refreshing state... [id=3ded465751ae7883faf871c4895d1c5d735723c3]
null_resource.provision: Refreshing state... [id=7457233514236216081]

Terraform used the selected providers to generate the following execution plan. Resource actions are indicated with the following symbols:
  + create
-/+ destroy and then create replacement

Terraform will perform the following actions:

  # docker_container.targets["target-node1"] will be created
  + resource "docker_container" "targets" {

（途中省略：target-node1〜target-node3のdocker_containerリソース、create計画の属性詳細）

  # local_file.ansible_inventory must be replaced
-/+ resource "local_file" "ansible_inventory" {
      ~ content              = <<-EOT
            [target_nodes]
            target-node1 ansible_host=172.18.0.2 ansible_user=ansible
            target-node2 ansible_host=172.20.0.2 ansible_user=ansible
            target-node3 ansible_host=172.20.0.3 ansible_user=ansible
        EOT -> (known after apply) # forces replacement
      ~ content_base64sha256 = "VnrRXOqdqicm1BxYzrfb4XD8DNmmuqHC6BtLInf8vuk=" -> (known after apply)
      ~ content_base64sha512 = "c6bsWpZpovUx9Y73ElRFumv7DoNqRO4KJ+U+A38o6Kf5glKZmoZKmAM4RxUC8Yn/h06T/3BvXpexTKjXvgziyQ==" -> (known after apply)
      ~ content_md5          = "e8539043cfbd0891503e21b84868cc81" -> (known after apply)
      ~ content_sha1         = "3ded465751ae7883faf871c4895d1c5d735723c3" -> (known after apply)
      ~ content_sha256       = "567ad15cea9daa2726d41c58ceb7dbe170fc0cd9a6baa1c2e81b4b2277fcbee9" -> (known after apply)
      ~ content_sha512       = "73a6ec5a9669a2f531f58ef7125445ba6bfb0e836a44ee0a27e53e037f28e8a7f98252999a864a980338471502f189ff874e93ff706f5e97b14ca8d7be0ce2c9" -> (known after apply)
      ~ id                   = "3ded465751ae7883faf871c4895d1c5d735723c3" -> (known after apply)
        # (3 unchanged attributes hidden)
    }

Plan: 4 to add, 0 to change, 1 to destroy.

Changes to Outputs:
  ~ target_nodes_ips = {
      ~ target-node1 = "172.18.0.2" -> (known after apply)
      ~ target-node2 = "172.20.0.2" -> (known after apply)
      ~ target-node3 = "172.20.0.3" -> (known after apply)
    }

Do you want to perform these actions?
  Terraform will perform the actions described above.
  Only 'yes' will be accepted to approve.

  Enter a value: yes

local_file.ansible_inventory: Destroying... [id=3ded465751ae7883faf871c4895d1c5d735723c3]
local_file.ansible_inventory: Destruction complete after 0s
docker_container.targets["target-node2"]: Creating...
docker_container.targets["target-node3"]: Creating...
docker_container.targets["target-node1"]: Creating...

（途中省略：target-node1〜target-node3のCreation complete）

local_file.ansible_inventory: Creating...
local_file.ansible_inventory: Creation complete after 0s [id=3ded465751ae7883faf871c4895d1c5d735723c3]

Apply complete! Resources: 4 added, 0 changed, 1 destroyed.

Outputs:

target_nodes_ips = {
  "target-node1" = "172.18.0.2"
  "target-node2" = "172.20.0.2"
  "target-node3" = "172.20.0.3"
}
```

続けて、生成された`inventory.ini`の内容を確認します。

**実行コマンド**
```plaintext
cat -n inventory.ini
```

**▼ 実行結果**
```plaintext
     1  [target_nodes]
     2  target-node1 ansible_host=172.18.0.2 ansible_user=ansible
     3  target-node2 ansible_host=172.20.0.2 ansible_user=ansible
     4  target-node3 ansible_host=172.20.0.3 ansible_user=ansible
```

### ■ 結果

`terraform apply`の実行によって、`docker_container.targets`の各リソースが持つIPアドレスが確定し、そのIPアドレスが`templatefile`関数を通じて`inventory.ini`に反映されていることを確認できました。`main.tf`側にはIPアドレスの値そのものは記述されておらず、Terraformが管理する状態（`network_data`）を起点に、Ansible側の成果物が生成される構造になっています。

生成された`inventory.ini`はAnsibleが読み込むINI形式のファイルであり、Ansible側から見れば通常のインベントリファイルと変わりません。

この構図自体は、**[第3回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part1/ansible-terraform-part1-03/)**・**[第5回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part1/ansible-terraform-part1-05/)**・**[第17回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part2/ansible-terraform-part2-17/)**・**[第22回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part3/ansible-terraform-part3-22/)** で扱ってきた、Terraformの生成物をAnsibleが実行時にどう認識するかという問題と似て見えるかもしれません。しかし今回問うのは、Ansibleが実行時に正しく動くかどうかではありません。この生成物が、ansible-lintという静的解析ツールの基準に対してどう見えるか、という実行前の観点です。次のセクションからは、この観点に絞って扱います。

このファイルの中身を決めているのはHCLの`templatefile`関数と、HCLのテンプレート構文（`%{ for }`）です。次のセクションでは、この生成元（HCL）と生成物（Ansible成果物）の記法の違いが、どのような形で表面化するかを整理します。

---

[↑ 目次に戻る](#-目次)

---

## 3. HCL側のテンプレート記法とYAML側の記法の非親和性

前セクションで確認した`inventory.ini`はINI形式でしたが、ここでは`group_vars`としてYAML形式の成果物を生成します。生成元となるHCLテンプレートを示します。

* **ファイル名：`group_vars_target_nodes.tftpl`**

```
nginx_settings:
  worker_connections: 768
  targets:
%{ for name, ip in ips ~}
  - name: ${name}
    ip: ${ip}
%{ endfor ~}
```

このテンプレートを`local_file`リソースで読み込み、`group_vars/target_nodes.yml`として出力します。

* **ファイル名：`main.tf`（該当箇所）**

```hcl
resource "local_file" "group_vars_target_nodes" {
  filename = "${path.module}/group_vars/target_nodes.yml"
  content = templatefile("${path.module}/group_vars_target_nodes.tftpl", {
    ips = {
      for name, container in docker_container.targets :
      name => container.network_data[0].ip_address
    }
  })
}
```

### ■ 検証内容：templatefileによるgroup_vars生成の確認

`terraform apply`を実行し、生成される`group_vars/target_nodes.yml`の内容を確認します。

**実行コマンド**

```plaintext
terraform apply
```

**▼ 実行結果**

```plaintext
tls_private_key.generated: Refreshing state... [id=01fef040852c30c6b7e1ca3cc397456584b4d7e4]
local_file.private_key: Refreshing state... [id=7d11d7745c28bb12f23b6501732973a67553e3e1]
docker_image.ansible_target_deploy_nopasswd: Refreshing state... [id=sha256:fdb892d2ff6bdaefd48c7e674ee994458a883bea1680475802219359aa56b758ansible-target:deploy-nopasswd]
docker_image.ansible_target_deploy_passwd: Refreshing state... [id=sha256:fdb892d2ff6bdaefd48c7e674ee994458a883bea1680475802219359aa56b758ansible-target:deploy-passwd]
docker_network.lab_net: Refreshing state... [id=261d153c5dc82cf69950a9289c1726cbde2f5a14fa9b2f395c58434d13c4a354]
docker_image.ansible_target_legacy: Refreshing state... [id=sha256:6396f6e711cb1cce4aaec489d9944bcf5f3e19997cb94345e194da7ca1b62b5aansible-target:ubuntu18.04]
docker_network.app_net: Refreshing state... [id=54f7b73fd1625642a3ef6ed67fbde6f93062353422a9afeced223cd940c4c5ca]
docker_image.ansible_target: Refreshing state... [id=sha256:3557c4c7ab005be7a378a329a5ca402ec4ae742c0b158cf872f2efe01bdb4a30ansible-target:ubuntu22.04]
null_resource.fix_permission: Refreshing state... [id=4436755063213838558]
docker_container.targets["target-node1"]: Refreshing state... [id=37ec27743c93df681f66ac31b2f14507a35a55540dca7b4b340ec3a0b74d609d]
docker_container.targets["target-node2"]: Refreshing state... [id=9371cd75cc4aea7f43e51ff39fbb18e599634d57fb90ce03ca65b21995327088]
docker_container.targets["target-node3"]: Refreshing state... [id=3ca0cbdc9df5ccd484b3573bdb539fb142c2e3248df2a2a4118053ebbb1f6192]
local_file.ansible_inventory: Refreshing state... [id=3ded465751ae7883faf871c4895d1c5d735723c3]
null_resource.provision: Refreshing state... [id=7457233514236216081]
Terraform used the selected providers to generate the following execution plan. Resource actions are indicated with the following symbols:
  + create
Terraform will perform the following actions:
  # local_file.group_vars_target_nodes will be created
  + resource "local_file" "group_vars_target_nodes" {
      + content              = <<-EOT
            nginx_settings:
              worker_connections: 768
              targets:
              - name: target-node1
                ip: 172.18.0.2
              - name: target-node2
                ip: 172.20.0.2
              - name: target-node3
                ip: 172.20.0.3
        EOT
      + content_base64sha256 = (known after apply)
      + content_base64sha512 = (known after apply)
      + content_md5          = (known after apply)
      + content_sha1         = (known after apply)
      + content_sha256       = (known after apply)
      + content_sha512       = (known after apply)
      + directory_permission = "0777"
      + file_permission      = "0777"
      + filename             = "./group_vars/target_nodes.yml"
      + id                   = (known after apply)
    }
Plan: 1 to add, 0 to change, 0 to destroy.
Do you want to perform these actions?
  Terraform will perform the actions described above.
  Only 'yes' will be accepted to approve.
  Enter a value: yes
local_file.group_vars_target_nodes: Creating...
local_file.group_vars_target_nodes: Creation complete after 0s [id=4cc3688710c2cdd461df58007e589aeca224b12f]
Apply complete! Resources: 1 added, 0 changed, 0 destroyed.
Outputs:
target_nodes_ips = {
  "target-node1" = "172.18.0.2"
  "target-node2" = "172.20.0.2"
  "target-node3" = "172.20.0.3"
}
```

続けて、生成された`group_vars/target_nodes.yml`の内容を確認します。

**実行コマンド**

```plaintext
cat -n group_vars/target_nodes.yml
```

**▼ 実行結果**

```plaintext
     1
     2  nginx_settings:
     3    worker_connections: 768
     4    targets:
     5    - name: target-node1
     6      ip: 172.18.0.2
     7    - name: target-node2
     8      ip: 172.20.0.2
     9    - name: target-node3
    10      ip: 172.20.0.3
```

### ■ 結果

生成された`group_vars/target_nodes.yml`には、先頭に空行が入っています。テンプレート側（`group_vars_target_nodes.tftpl`）の1行目には`nginx_settings:`しか書いていませんが、生成物には空行が加わっています。

インデントの構造にも注目します。`targets:`とその配下のリスト項目（`- name: target-node1`）は、どちらも2スペースのインデント位置に並んでいます。テンプレート側では、`targets:`を2スペースで書き、リスト項目の`- name:`もそのまま2スペースで書いていました。この記述通りに生成された結果、`targets`というキーとその配下のリスト項目が、見た目上は同じ階層に並ぶ形になっています。

YAMLの構文としては、リスト項目を親キーと同じインデント位置に置く書き方も有効です。しかし、このインデントの深さをどう取るかは、HCLテンプレート側の記述（`%{ for }`をどこに置き、リスト項目をどれだけ字下げするか）がそのまま反映される構造になっており、YAML側で望ましいとされるインデントの深さを、HCLテンプレートの記述だけで意識的に作り込む必要があります。

`terraform fmt`は、HCLテンプレート内の文字列リテラル（ヒアドキュメントの中身）には手を入れません。テンプレート内の字下げが`terraform fmt`を通過しても、生成後のYAMLのインデントが妥当かどうかは、`terraform fmt`とは別の基準で判断されることになります。次のセクションでは、この生成物に対してansible-lintを実行した場合に、実際にどのような指摘が出るかを確認します。

---

[↑ 目次に戻る](#-目次)

---

## 4. ansible-lintが指摘するルールとの衝突

前セクションで生成した`group_vars/target_nodes.yml`に対して、`ansible-lint`を実行します。

### ■ 検証内容：生成されたgroup_varsに対するansible-lintの実行確認

**実行コマンド**

```plaintext
ansible-lint --project-dir . group_vars/target_nodes.yml
```

**▼ 実行結果**

```plaintext
WARNING  Listing 2 violation(s) that are fatal
yaml[empty-lines]: Too many blank lines (1 > 0)
group_vars/target_nodes.yml:1
yaml[indentation]: Wrong indentation: expected 4 but found 2
group_vars/target_nodes.yml:5
Read documentation for instructions on how to ignore specific rule violations.
# Rule Violation Summary
  1 yaml profile:basic tags:formatting,yaml
  1 yaml profile:basic tags:formatting,yaml
Failed: 2 failure(s), 0 warning(s) in 1 files processed of 1 encountered. Last profile that met the validation criteria was 'min'.
```

### ■ 結果

`ansible-lint`は2件の違反を検出しました。

1件目は`yaml[empty-lines]`です。`group_vars/target_nodes.yml`の1行目に空行が入っていることが指摘されています。これは、生成元の`group_vars_target_nodes.tftpl`の記述が、そのままファイルの先頭に反映された結果です。HCLのヒアドキュメント構文は、テンプレートファイルの記述内容をそのまま文字列として扱うため、テンプレート側の改行の有無が、生成後のYAMLファイルの空行としてそのまま現れます。

2件目は`yaml[indentation]`です。`targets:`配下のリスト項目（`- name: target-node1`）のインデントについて、「4を期待したが2だった」と指摘されています。前セクションで確認した通り、生成元のテンプレートでは`targets:`とリスト項目の`- name:`を同じ2スペースの位置に記述していました。この記述がそのまま反映された結果、ansible-lintが期待するインデント幅（親キーから4スペース）に届いていません。

どちらの違反も、生成物であるYAMLファイル単体を見て初めて検出されるものです。生成元のHCLテンプレートを見ているだけでは、これらの違反が発生することは分かりません。`terraform fmt`はHCLの構文としての整形は行いますが、テンプレート内の文字列リテラルがYAMLとしてどう解釈されるかまでは関知しません。この2つのツールの間には、互いの整形基準を橋渡しする仕組みが存在しないため、HCL側が正しく整形されていても、生成後のYAMLがansible-lintの基準を満たすとは限らない、という構造がここで確認できました。

次のセクションでは、この構造がCI/CDパイプラインでどのような形で現れるかを整理します。

---

[↑ 目次に戻る](#-目次)

---

## 5. CI/CDパイプラインでの競合の現れ方

前セクションまでで、生成物であるYAMLファイルがansible-lintの指摘を受ける一方、その生成元であるHCLテンプレートの中身は`terraform fmt`の対象にならないことを確認しました。このセクションでは、`terraform validate`、`terraform fmt -check`、`ansible-lint`を実行し、それぞれのツールが実際にどう反応するかを確認します。

### ■ 検証内容：terraform validate、terraform fmt -checkの実行確認

**実行コマンド**

```plaintext
terraform validate
```

**▼ 実行結果**

```plaintext
Success! The configuration is valid.
```

**実行コマンド**

```plaintext
terraform fmt -check
```

**▼ 実行結果**

```plaintext
main.tf
```

### ■ 結果

`terraform validate`は成功しました。一方、`terraform fmt -check`は`main.tf`を出力しています。`terraform fmt -check`は、整形が必要なファイルがある場合にそのファイル名を出力する仕様のため、この時点で`main.tf`のフォーマットに崩れがあることが分かります。

`terraform validate`が成功していても、`terraform fmt -check`は独立して失敗することがあります。前者はHCLとして構文的に正しいかどうかを判定し、後者はHCLの記述が整形ルールに沿っているかどうかを判定するものであり、両者の判定基準は別物です。

### ■ 検証内容：terraform fmt実行後の再確認

**実行コマンド**

```plaintext
terraform fmt
```

**▼ 実行結果**

```plaintext
main.tf
```

**実行コマンド**

```plaintext
terraform fmt -diff
```

**▼ 実行結果**
```
※（出力なし）
```
### ■ 結果

`terraform fmt`を実行すると、整形されたファイルとして`main.tf`が出力されました。続けて`terraform fmt -diff`を実行したところ、出力は何もありませんでした。これは、整形の対象となる差分がもう存在しない、つまり`main.tf`が`terraform fmt`の基準を満たす状態になったことを示しています。

ここまでの結果を踏まえると、`terraform validate`、`terraform fmt -check`、`ansible-lint`は、それぞれ独立したタイミングで、独立した基準に基づいて評価を行っています。`terraform validate`が成功していても`terraform fmt -check`は失敗することがあり、`terraform fmt -check`が成功している状態でも、生成後のYAMLに対する`ansible-lint`は別途失敗することがあります（**[第4節](#4-ansible-lintが指摘するルールとの衝突)**）。

3つのツールがそれぞれ別のファイル、別の基準で判定を行うため、あるツールを満たすための修正が、他のツールの判定結果に影響するとは限りません。HCL側のフォーマットを整えても、それによって生成されるYAMLのインデントや空行の問題が自動的に解消されるわけではなく、逆にYAML側の問題を解消するためにHCLテンプレートの記述を変更しても、それが`terraform fmt`の基準に沿っているとは限りません。それぞれのツールを個別に通そうとする限り、両方の基準を同時に満たす記述にたどり着くまで、修正のやり直しが発生しうる構造です。

次のセクションでは、この構造を避けるための設計パターンを整理します。

---

[↑ 目次に戻る](#-目次)

---

## 6. 緩和のための設計パターン

ここまでの実機検証で、HCLテンプレートの記述がそのまま反映されたYAMLが、ansible-lintの指摘を受けること、そしてこの指摘は`terraform fmt`側では検知されないことを確認しました。このセクションでは、この構造を避けるための設計パターンを整理します。

### パターンA：役割分担の見直し

Terraformは`output`としてIPアドレス等の値を出力するだけにとどめ、YAMLへの整形はAnsible側のJinja2テンプレート（`group_vars`用の`.j2`テンプレート等）に任せる、という役割分担です。この場合、TerraformとAnsibleの間を受け渡すのは`terraform output -json`で取得できるプレーンな値のデータであり、YAMLの記法そのものはAnsible側のテンプレートエンジン（Jinja2）が担うことになります。HCLのテンプレート構文（`%{ for }`等）がYAMLのインデントを直接生成する場面自体がなくなるため、今回確認したような、生成元と生成物の記法が食い違うという問題そのものが起こりません。

この方式は、TerraformとAnsibleの間で受け渡す値の形式（JSON等）を新たに整える必要があり、既存の`local_file`＋`templatefile`による構成からの作り直しを伴います。今回の検証環境のように、`templatefile`で直接Ansible成果物を生成する構成をすでに採用している場合、この役割分担への移行は、既存の構成を置き換える規模の変更になります。

### パターンB：後処理による整形

パターンAがそもそもTerraformにYAMLを生成させない方向の対処だったのに対し、パターンBはHCLテンプレート側の記述を変えずに、生成後のファイルに対する後処理で吸収する方法です。

`ansible-lint`には`--fix`オプションがあり、検出したYAML関連の違反に対して、ファイルを直接書き換える再整形処理を実行できます。前セクションで検出した`group_vars/target_nodes.yml`に対して、このオプションを実行します。

### ■ 検証内容：ansible-lint --fixによる自動整形の確認

**実行コマンド**

```plaintext
ansible-lint --fix --project-dir . group_vars/target_nodes.yml
```

**▼ 実行結果**

```plaintext
ERROR    Rule specific fix not applied for: yaml[empty-lines]/yaml group_vars/target_nodes.yml:1
ERROR    Rule specific fix not applied for: yaml[indentation]/yaml group_vars/target_nodes.yml:5[/]
Modified 1 file.
Passed: 0 failure(s), 0 warning(s) in 1 files processed of 1 encountered. Last profile that met the validation criteria was 'production'.
```

続けて、修正後のファイルの中身と、再度の`ansible-lint`実行結果を確認します。

**実行コマンド**

```plaintext
cat -n group_vars/target_nodes.yml
```

**▼ 実行結果**

```plaintext
     1  ---
     2  nginx_settings:
     3    worker_connections: 768
     4    targets:
     5      - name: target-node1
     6        ip: 172.18.0.2
     7      - name: target-node2
     8        ip: 172.20.0.2
     9      - name: target-node3
    10        ip: 172.20.0.3
```

**実行コマンド**

```plaintext
ansible-lint --project-dir . group_vars/target_nodes.yml
```

**▼ 実行結果**

```plaintext
Passed: 0 failure(s), 0 warning(s) in 1 files processed of 1 encountered. Last profile that met the validation criteria was 'production'.
```

### ■ 結果

`--fix`実行時のログには、`yaml[empty-lines]`、`yaml[indentation]`のそれぞれについて「ルール固有の修正は適用されなかった（Rule specific fix not applied for）」と表示されています。しかし同時に`Modified 1 file.`とも表示されており、実際にファイルは書き換えられています。

書き換え後の内容を見ると、先頭に`---`が追加されて元の空行が解消され、`targets:`配下のリスト項目のインデントも一段深い位置に変わっています。再度`ansible-lint`を実行した結果は`Passed: 0 failure(s), 0 warning(s)`となり、前セクションで検出した2件の違反はいずれも解消しました。

「ルール固有の修正は適用されなかった」というログと、実際に違反が解消したという結果は、一見矛盾しているように見えます。これは、`--fix`が個別ルールに紐づいた修正処理とは別に、YAMLファイル全体を読み込んで書き出し直す汎用的な再整形処理を行っており、今回の2件の違反はこの汎用的な再整形によって結果的に解消された、という理解になります。個別ルールの修正が適用されなかったこと自体は、この再整形が働かなかったことを意味しません。

このパターンの利点は、HCLテンプレート側の記述を変更せずに、生成後のファイルに対する後処理だけで違反を解消できる点です。`templatefile`の記述はそのままに、CI/CDパイプラインの中で生成後に`ansible-lint --fix`を挟む、あるいは生成物を`ansible-lint`でチェックしたのち`--fix`で整形してからコミットする、といった運用が考えられます。一方で、後処理が何を書き換えたのかは、実行結果を都度確認しない限り把握しづらく、生成物の内容がテンプレートの記述から一段離れることには留意が必要です。

### まとめ（このセクションの整理）

パターンAは、TerraformとAnsibleの役割分担そのものを見直すことで問題の発生源を断つ方法であり、記法の競合という問題自体を避けられますが、既存構成からの移行コストがかかります。パターンBは、既存の構成を変えずに後処理で対処する方法であり、導入のコストは低い一方、生成物がテンプレートの記述から一段離れる点に留意が必要です。どちらを選ぶかは、既存構成をどこまで維持したいか、CI/CDパイプラインにどこまで後処理を組み込めるかによって変わります。

---

[↑ 目次に戻る](#-目次)

---

## 7. まとめ

この回で整理した内容を確認します。

* Terraformの`templatefile`関数を使うと、Terraformが管理する値（コンテナのIPアドレス等）を埋め込んだAnsibleの成果物（インベントリファイル、`group_vars`）を動的生成できる。生成物はYAML/INI形式だが、生成元はHCLのテンプレート構文で書かれている
* HCLテンプレート側の記述（改行の有無、インデント幅）は、生成後のYAMLファイルにそのまま反映される。今回の検証では、テンプレート先頭の空行、`targets:`配下のリスト項目のインデントが、そのまま`ansible-lint`の`yaml[empty-lines]`、`yaml[indentation]`の指摘につながった
* `terraform validate`、`terraform fmt -check`、`ansible-lint`は、それぞれ独立した基準で評価を行う。`terraform validate`が成功していても`terraform fmt -check`は失敗することがあり、`terraform fmt -check`が成功していても、生成後のYAMLに対する`ansible-lint`は別途失敗することがある
* 緩和策として、TerraformをAnsible成果物の生成から切り離し、値の出力（`output`）のみに専念させ、Ansible側のJinja2テンプレートでYAMLを整形する役割分担（パターンA）、または`templatefile`による生成構成を維持したまま`ansible-lint --fix`を後処理として挟む方法（パターンB）がある
* `ansible-lint --fix`は、ログ上「ルール固有の修正は適用されなかった」と表示されていても、YAMLファイル全体を対象とした汎用的な再整形処理によって、実際には違反が解消することがある

---

[↑ 目次に戻る](#-目次)

---

## 8. 次回予告

**[第24回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part3/ansible-terraform-part3-24/)** では、Terraformの並列リソース生成とAnsibleのforks並列実行が同じコントロールホスト上で重なった場合に、CPU、メモリ、ファイルディスクリプタ等が構造的に圧迫されうる仕組みを整理しました。**[第25回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part3/ansible-terraform-part3-25/)** となる今回は、実行ホスト自体のリソースという制約から離れ、HCL構文チェックとansible-lintという、静的解析ツール同士のルールが競合する問題を扱いました。`templatefile`によるAnsible成果物の動的生成という構成を起点に、HCL側の整形とYAML側の整形が別々の基準で評価される構造を、実機検証を交えて確認しました。

次回は、静的解析ツール同士の競合という「実行前」の問題から離れ、Terraformの`local-exec`経由でAnsibleの`become`を実行する構成において、パスワード入力を要求するオプションを指定した場合に限り、非対話実行環境で処理が無応答のまま停止してしまう問題を扱います。

**[次回：第26回：管理者権限（sudo）実行時におけるパスワード入力のプロンプト停止](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part3/ansible-terraform-part3-26/)**

---

📑 連載の移動　**[前の記事：【Ansible×Terraform編】第24回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part3/ansible-terraform-part3-24/)　｜　[次の記事：【Ansible×Terraform編】第26回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part3/ansible-terraform-part3-26/)**

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

### 第3部：トラブルシューティング、デバッグ編

|回数|テーマ、記事タイトル|概要|
|---|---|---|
|**[第21回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part3/ansible-terraform-part3-21/)**|統合実行時におけるネストされたエラーログの解析手法|Terraformの`local-exec`経由で実行されたAnsibleのエラーログから、原因がTerraform側（HCL、State）かAnsible側（Playbook、タスク）かを特定する手法。|
|**[第22回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part3/ansible-terraform-part3-22/)**|マルチネットワーク環境におけるインターフェース競合|複数ネットワーク（Dockerネットワーク等）をアタッチした際、Ansibleの`ansible_default_ipv4`や接続IPの自動検出が意図しないインターフェースに引きずられる問題。|
|**[第23回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part3/ansible-terraform-part3-23/)**|大容量ファイル転送、重いタスク実行時におけるSSHタイムアウト|Ansibleで大きなアセットや大量のパッケージを転送、適用する際、Terraform側のプロビジョナータイムアウトに引っかかる可能性がある問題を扱う。|
|**[第24回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part3/ansible-terraform-part3-24/)**|並列実行時における実行ホストのシステムリソース枯渇対策|`parallelism`や`forks`設定により、大量のリソース構築とAnsibleプロビジョニングが同時に走った場合、ホストのCPU、メモリ、ファイルディスクリプタが枯渇しうる問題を扱う。|
|**[第25回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part3/ansible-terraform-part3-25/)**|構文チェックツール（HCL構文、ansible-lint）の競合緩和|両ツールの静的解析ツール（`terraform fmt`、`ansible-lint`）を導入した際、コード記述ルールや命名規則の不一致でCIが通らなくなる問題。|
|**[第26回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part3/ansible-terraform-part3-26/)**|管理者権限（sudo）実行時におけるパスワード入力のプロンプト停止|Terraformのlocal-exec経由でAnsibleのbecomeを実行する際、パスワード入力を要求するオプションを指定した場合に限り、非対話実行環境で処理が無応答のまま停止する問題。|
|**[第27回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part3/ansible-terraform-part3-27/)**|再起動、再生成に伴うプロビジョニング断絶|AnsibleのrebootモジュールによるOS再起動時、接続断絶が正常な過程か異常な停止かをTerraformのlocal-execが区別できず、外側のタイムアウトと競合する問題。|
|**[第28回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part3/ansible-terraform-part3-28/)**|異種OS（Windowsターゲット）混在環境における接続プロトコルの制約|SSHではなくWinRM等を用いる特殊プロトコル環境での接続、権限エラー。実務でWindows ServerをAnsible×Terraformで管理する際の構造的注意点を扱う概念解説回。|
|**[第29回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part3/ansible-terraform-part3-29/)**|プロキシ環境等における外部コレクション（Ansible Galaxy）の取得失敗|インフラ構築処理の途中で外部ネットワーク（Ansible Galaxy等）への依存が切れ、Terraformの処理全体が失敗する問題。|
|**[第30回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part3/ansible-terraform-part3-30/)**|デバッグフラグの組み合わせによるログ解析の高度化|Terraformの`TF_LOG`とAnsibleの`-vvvv`を組み合わせ、接続遅延や処理遅延のボトルネックを特定、解消する手法。|

---

[↑ 目次に戻る](#-目次)

---
