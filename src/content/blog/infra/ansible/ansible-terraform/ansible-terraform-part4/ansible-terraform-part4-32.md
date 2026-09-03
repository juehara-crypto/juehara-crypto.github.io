---
title: '「AnsibleとTerraformの連携が壊れる理由はライフサイクルにあった」 第32回：GitHub Actionsを用いたプロビジョニングコードの自動テスト環境構築'
description: 'GitHub-hostedランナーに標準搭載されたDocker Engineを用いて、Terraformによるコンテナ起動からAnsible適用までを一連のジョブとして自動実行するCI/CD環境を扱う。ローカル環境とCI環境の実行内容の一致性、CI特有のコンテナ運用の特徴を整理する。'
pubDate: 2026-09-01
category: 'infra'
tags: ['Ansible', 'Terraform', 'GitHub Actions', 'CI/CD', 'E2Eテスト']
seriesId: 'ansible-terraform-part4'
seriesNo: 32
prevPost: 'https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part4/ansible-terraform-part4-31/'
nextPost: 'https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part4/ansible-terraform-part4-33/'
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
2. [GitHub-hostedランナーとコンテナ操作の関係](#2-github-hostedランナーとコンテナ操作の関係)
3. [ワークフローの構成](#3-ワークフローの構成)
4. [Terraformによるコンテナ起動のCI実行](#4-terraformによるコンテナ起動のci実行)
5. [Ansible適用のCI実行](#5-ansible適用のci実行)
6. [ローカル環境との再現性](#6-ローカル環境との再現性)
7. [CI実行後の後始末](#7-ci実行後の後始末)
8. [まとめ](#8-まとめ)
9. [次回予告](#9-次回予告)
10. [連載一覧：「AnsibleとTerraformの連携が壊れる理由はライフサイクルにあった」](#10-連載一覧ansibleとterraformの連携が壊れる理由はライフサイクルにあった)

---

## 1. はじめに

「手元では動くのに、CI上ではどう動くか分からない」という状態のまま、CI/CDパイプラインの設計を進めたことはないでしょうか。

**[第31回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part4/ansible-terraform-part4-31/)** では、`local-exec`経由でAnsibleを直接実行する密結合構成を見直し、Terraformの責務を状態（tfstate、`output`）の出力に限定する疎結合設計への移行を扱いました。`terraform output -json`と動的インベントリスクリプトを組み合わせることで、Terraformのプロセスから完全に独立してAnsibleを実行できることを、実機検証を交えて確認しました。

この疎結合化によって、TerraformとAnsibleの実行順序を保証する仕組みがなくなるという課題が新たに生じました。手動実行を前提とする限り、`terraform apply`の後にAnsibleを実行し忘れる、実行順序を誤るといったことが、実行者の注意力に依存してしまいます。

第32回 となる今回は、この課題に対し、GitHub Actions上でコンテナの起動からAnsible適用までを一連のジョブとして自動実行する仕組みを扱います。GitHub-hostedランナーには標準でDocker Engineが搭載されており、追加のセットアップなしに`kreuzwerker/docker` providerによるコンテナ操作をCI上でそのまま実行できます。この特性を利用し、コードのプッシュをトリガーとして、これまで手元でしか確認できなかった一連の動作を、CI上でも同じ手順で再現する運用への切り替えを、この回で示します。

次のセクションでは、この回の前提となる、GitHub-hostedランナーとコンテナ操作の関係を確認します。

---

[↑ 目次に戻る](#-目次)

---

## 2. GitHub-hostedランナーとコンテナ操作の関係

この回の前提となる仕組みを確認します。

`ubuntu-latest`ランナーには標準でDocker Engineが搭載されており、追加のセットアップなしに`kreuzwerker/docker` providerによるコンテナ操作がそのまま実行できるかを確認します。ここでは、この事実を確認するための最小構成の例を示します。実際に本題で使うワークフローの構成は、次のセクションで組み立てます。

* **ファイル名：**`.github/workflows/e2e-provisioning-test.yml`

```yaml
name: E2E Provisioning Test

on:
  workflow_dispatch:

jobs:
  e2e-test:
    runs-on: ubuntu-latest
    steps:
      - name: Check Docker availability
        run: docker version
```

このワークフローを、GitHub Actionsの手動トリガー（`workflow_dispatch`）で実行します。

**▼ 実行結果**

![GitHub Actions実行結果（docker versionの出力）](/images/blog/infra/ansible/ansible-terraform/ansible-terraform-part4/ansible-terraform-part4-32/section2-actions-success.png)

### ■ 結果

`docker version`がエラーなく実行され、Client、Serverの両方のバージョン情報（Docker Engine - Community 28.0.4）が返ってきました。追加のインストール作業を一切行っていないにもかかわらず、ランナー上でDockerコマンドが即座に利用できる状態になっていることが確認できます。

この結果により、次のセクション以降で扱う`kreuzwerker/docker` providerによるコンテナ操作を、GitHub Actions上でそのまま実行できる前提が整ったことになります。

---

[↑ 目次に戻る](#-目次)

---

## 3. ワークフローの構成

この回で構築するワークフロー全体の流れを示します。

`.github/workflows/`配下にYAMLファイルを配置し、コードのチェックアウトからAnsible適用までの一連のジョブを定義する構造を確認します。

* **ファイル名：**`.github/workflows/e2e-provisioning-test.yml`

```yaml
name: E2E Provisioning Test

on:
  workflow_dispatch:

jobs:
  e2e-test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Check Docker availability
        run: docker version
      - uses: hashicorp/setup-terraform@v3
```

セクション2で確認したDocker Engineの標準搭載に加え、`actions/checkout@v4`によるコードのチェックアウト、`hashicorp/setup-terraform@v3`によるTerraformのセットアップを追加しました。以降のセクションで、この後に`terraform apply`、Ansible適用のステップを続けていきます。

このワークフローを、GitHub Actionsの手動トリガー（`workflow_dispatch`）で実行します。

### ■ 結果

`Checkout`、`Check Docker availability`、`Setup Terraform`の3ステップがいずれも正常に完了し、ジョブ全体もSuccessとなりました。コードのチェックアウトとTerraformのセットアップが、追加の手作業なしにワークフロー内で完結することが確認できます。

---

[↑ 目次に戻る](#-目次)

---

## 4. Terraformによるコンテナ起動のCI実行

Terraform側の実行ステップを詳細化します。

* **ファイル名：**`.github/workflows/e2e-provisioning-test.yml`

```yaml
      - name: Terraform Init
        run: terraform init
      - name: Terraform Apply
        env:
          TF_VAR_ansible_user_password: ${{ secrets.TF_VAR_ANSIBLE_USER_PASSWORD }}
          TF_VAR_deploy_user_password: ${{ secrets.TF_VAR_DEPLOY_USER_PASSWORD }}
        run: terraform apply -auto-approve
      - name: Export inventory
        run: terraform output -json target_nodes > inventory.json
```

`ansible_user_password`、`deploy_user_password`は、GitHub Secretsに登録した値を、`env`ブロックで環境変数として`Terraform Apply`ステップにのみ渡しています。

このワークフローを、GitHub Actions上で実行します。

**▼ 実行結果**

```plaintext
Run terraform apply -auto-approve

Terraform used the selected providers to generate the following execution
plan. Resource actions are indicated with the following symbols:
  + create

Terraform will perform the following actions:

  # docker_container.targets["target-node1"] will be created
  + resource "docker_container" "targets" {
      + name                                        = "target-node1"
      + networks_advanced {
          + name         = "***-app-net"
        }
      + networks_advanced {
          + name         = "***-lab-net"
        }
      + ports {
          + external = 2231
          + internal = 22
        }
（途中省略）

  # docker_image.***_target will be created
  + resource "docker_image" "***_target" {
      + name        = "***-target:ubuntu22.04"
      + build {
          # At least one attribute in this block is (or was) sensitive,
          # so its contents will not be displayed.
        }
    }
（途中省略）

Plan: 14 to add, 0 to change, 0 to destroy.

Changes to Outputs:
  + target_nodes     = {
      + target-node1 = {
          + host = (known after apply)
          + port = 22
        }
      + target-node2 = {
          + host = (known after apply)
          + port = 22
        }
      + target-node3 = {
          + host = (known after apply)
          + port = 22
        }
    }
tls_private_key.generated: Creating...
tls_private_key.generated: Creation complete after 0s [id=8a8588ec28ea6cc4154d7ec4266024a26b339029]
docker_image.***_target_***_passwd: Creating...
docker_image.***_target_***_nopasswd: Creating...
docker_image.***_target_legacy: Creating...
docker_network.lab_net: Creating...
docker_network.app_net: Creating...
docker_image.***_target: Creating...
local_file.private_key: Creating...
local_file.private_key: Creation complete after 0s [id=8c6d63fda1b005bb28e3ba0940186a6311d2e23d]
null_resource.fix_permission: Creating...
null_resource.fix_permission: Provisioning with 'local-exec'...
null_resource.fix_permission (local-exec): Executing: ["/bin/sh" "-c" "chmod 0600 ./id_ed25519_generated"]
null_resource.fix_permission: Creation complete after 0s [id=4281067492930446117]
docker_network.app_net: Creation complete after 2s [id=d0f9e438c84a61a946b0d033f05baf8159af66fec670b030d44a85fe0a5b4552]
docker_network.lab_net: Creation complete after 3s [id=0361a13b000a5fbda9131caaee1cf21bfda63121a74cdded91caacf64d31473d]
（途中省略）
docker_image.***_target: Creation complete after 43s [id=sha256:2d5fd808926af7e9d8979650caeb4091c412213055a7b72cc7c49149b23d3411***-target:ubuntu22.04]
docker_container.targets["target-node3"]: Creating...
docker_container.targets["target-node1"]: Creating...
docker_container.targets["target-node2"]: Creating...
docker_image.***_target_***_passwd: Creation complete after 43s [id=sha256:3be4652d7d3ebfe68c493c9f8b5010e1101adbc0366b772c3577c4fd5050188e***-target:***-passwd]
docker_image.***_target_***_nopasswd: Creation complete after 43s [id=sha256:3be4652d7d3ebfe68c493c9f8b5010e1101adbc0366b772c3577c4fd5050188e***-target:***-nopasswd]
docker_container.targets["target-node3"]: Creation complete after 1s [id=1e355c3faa227b2f5f22532be3683c272b8c7ea46e6cce7ac8f52fe068111cfe]
docker_container.targets["target-node2"]: Creation complete after 1s [id=96abd4aa34688700d882a51f1c2dcba6d93e34c27f4c86dbb05ce6c839961e64]
docker_container.targets["target-node1"]: Creation complete after 1s [id=9f77dbcea4aecdf88773a837e6ff3f62475b48e1d9bfc0f1e974856a3523baf2]
local_file.***_inventory: Creating...
local_file.group_vars_target_nodes: Creating...
local_file.***_inventory: Creation complete after 0s [id=73edbc25ffba94fe81612cc96f08238251a38f2e]
local_file.group_vars_target_nodes: Creation complete after 0s [id=698a20723e947176e184bde67456a465fcf21644]
docker_image.***_target_legacy: Still creating... [00m50s elapsed]
docker_image.***_target_legacy: Creation complete after 51s [id=sha256:f1dd3ef964025ab71fd9bc8a3c12aac5976ab88609b1946118aff191700e1adf***-target:ubuntu18.04]

Apply complete! Resources: 14 added, 0 changed, 0 destroyed.

Outputs:

target_nodes = {
  "target-node1" = {
    "host" = "172.18.0.2"
    "port" = 22
  }
  "target-node2" = {
    "host" = "172.19.0.2"
    "port" = 22
  }
  "target-node3" = {
    "host" = "172.19.0.3"
    "port" = 22
  }
}
target_nodes_ips = {
  "target-node1" = "172.18.0.2"
  "target-node2" = "172.19.0.2"
  "target-node3" = "172.19.0.3"
}
```

### ■ 結果

CI上で`terraform apply`が正常に完了し、target-node1〜3を含む14リソースがすべて新規作成されました。ローカルの`terraform.tfstate`が存在しないCI環境でも、`main.tf`の定義に基づいて、ゼロの状態からコンテナが起動できることが確認できます。

ログ中の`***`は、GitHub SecretsのマスキングによってSecretの値と一致する文字列が自動的に伏字化されたものです。`Terraform Apply`ステップの`env`ブロックに設定したパスワード値だけでなく、リソース名の一部に含まれる同一の文字列も対象になっています。`docker_image`リソースの`build`ブロックについても、Sensitiveな属性を含むため内容が表示されない仕様になっており、パスワードの実値がログ上に一切露出していないことが確認できます。

最後に、`terraform output -json target_nodes`の結果を`inventory.json`として出力しました。この内容を次のセクションでAnsible適用に使用します。

---

[↑ 目次に戻る](#-目次)

---

## 5. Ansible適用のCI実行

Ansible側の実行ステップを詳細化します。

* **ファイル名：**`.github/workflows/e2e-provisioning-test.yml`

```yaml
      - name: Set up Python
        uses: actions/setup-python@v5
        with:
          python-version: "3.12"
      - name: Install Ansible
        run: pip install ansible
      - name: Set executable permission for dynamic inventory
        run: chmod +x dynamic_inventory.py
      - name: Run Ansible Playbook
        run: ansible-playbook -i dynamic_inventory.py site.yml
```

**[第31回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part4/ansible-terraform-part4-31/)** で構築した動的インベントリスクリプト（`dynamic_inventory.py`）を、CI上でもそのまま利用します。

このワークフローを、GitHub Actions上で実行します。

**▼ 実行結果**

```plaintext
Run ansible-playbook -i dynamic_inventory.py site.yml

PLAY [接続確認用Playbook] ******************************************************
TASK [疎通確認] ****************************************************************
[WARNING]: Host 'target-node2' is using the discovered Python interpreter at '/usr/bin/python3.10', but future installation of another Python interpreter could cause a different interpreter to be discovered. See https://docs.ansible.com/ansible-core/2.21/reference_appendices/interpreter_discovery.html for more information.
[WARNING]: Host 'target-node3' is using the discovered Python interpreter at '/usr/bin/python3.10', but future installation of another Python interpreter could cause a different interpreter to be discovered. See https://docs.ansible.com/ansible-core/2.21/reference_appendices/interpreter_discovery.html for more information.
[WARNING]: Host 'target-node1' is using the discovered Python interpreter at '/usr/bin/python3.10', but future installation of another Python interpreter could cause a different interpreter to be discovered. See https://docs.ansible.com/ansible-core/2.21/reference_appendices/interpreter_discovery.html for more information.
ok: [target-node2]
ok: [target-node3]
ok: [target-node1]
PLAY RECAP *********************************************************************
target-node1               : ok=1    changed=0    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
target-node2               : ok=1    changed=0    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
target-node3               : ok=1    changed=0    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
```

### ■ 結果

target-node1〜3のすべてに対する疎通確認が`ok=1、failed=0、unreachable=0`で完了しました。ローカル環境と同様の`dynamic_inventory.py`を、CI環境でも変更なく利用でき、Terraformが払い出したコンテナに対してAnsibleが正しく接続できることが確認できます。

これで、コードのチェックアウトからTerraformによるコンテナ起動、Ansible適用までの一連の流れが、GitHub Actions上で一貫して実行できることが確認できました。

---

[↑ 目次に戻る](#-目次)

---

## 6. ローカル環境との再現性

CI環境とローカル環境の一致性を整理します。

Ubuntu-Controlで実行していたコマンド列（`terraform init` → `terraform apply` → `ansible-playbook`）が、CI上でもほぼそのまま実行できる構成になっている点を確認します。
```

【ローカル環境での実行】  
terraform init → terraform apply → ansible-playbook -i dynamic_inventory.py site.yml

【CI環境での実行】  
terraform init → terraform apply → ansible-playbook -i dynamic_inventory.py site.yml  
　　　　　　　　（同一のコマンド列）

```

コマンド列が一致していることにより、「ローカルで確認した内容が、そのままCI上でも再現される」という信頼性が生まれます。一方で、ローカル環境固有の設定（実行ユーザーのホームディレクトリに依存するパス等）は、CI環境ではそのまま使えない場合があり、そうした箇所は別途CI環境向けに調整する必要があります。

---

[↑ 目次に戻る](#-目次)

---



## 7. CI実行後の後始末

CI特有の運用上の特徴を整理します。

CI上で起動したコンテナは、ジョブ終了時にランナー自体が破棄されるため、`terraform destroy`のような明示的な後始末を挟まなくても環境が残り続けることはありません。
```

【ローカル環境】  
検証終了後、明示的にterraform destroyを実行しない限りコンテナが残り続ける

【CI環境】  
ジョブ終了時にランナーごと破棄されるため、後始末が自動的に完了する

```

セクション4、5でこれまで複数回実行したワークフローでは、実行のたびにtarget-node1〜3が新しいIPアドレスで作成されていました。これは、前回のtfstateやコンテナがランナー上に残っておらず、毎回ゼロの状態からリソースが作成されていることを示しています。一方で、ジョブ間でコンテナの状態を引き継ぐことはできず、実行のたびに新規のコンテナが作られる点も、この仕組みの裏返しとして留意が必要です。

---

[↑ 目次に戻る](#-目次)

---

## 8. まとめ

この回で整理した内容を確認します。

* GitHub-hostedランナー（`ubuntu-latest`）には標準でDocker Engineが搭載されており、追加のセットアップなしに`kreuzwerker/docker` providerによるコンテナ操作がそのまま実行できることを実機で確認した
* `.github/workflows/`配下のYAMLファイルで、コードのチェックアウトからTerraformによるコンテナ起動、Ansible適用までの一連のジョブを定義できる
* Terraformの`variable`にパスワード等の機密情報を渡す場合、GitHub Secretsに登録し、`env`ブロックで対象ステップにのみ環境変数として渡すことで、コード上に実値を残さずに済む
* **[第31回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part4/ansible-terraform-part4-31/)** で構築した動的インベントリスクリプト（`dynamic_inventory.py`）を、CI環境でも変更なく利用でき、ローカルとほぼ同一のコマンド列で、Terraformによるコンテナ起動からAnsible適用までを実行できることを確認した
* CI上で起動したコンテナは、ジョブ終了時にランナーごと破棄されるため、明示的な後始末が不要になる一方、ジョブ間での状態の引き継ぎはできない
* ローカル環境で動いていた設定（実行ユーザーのホームディレクトリに依存するパス等）が、CI環境ではそのまま使えない場合があり、環境間で見直しが必要になる箇所が存在する

---

[↑ 目次に戻る](#-目次)

---

## 9. 次回予告

**[第31回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part4/ansible-terraform-part4-31/)** では、第4部の起点として、Terraformの`local-exec`経由でAnsibleを直接実行する密結合構成を見直し、Terraformの責務を状態の出力に限定する疎結合設計への移行を扱いました。第32回 となる今回は、この疎結合化によって生じた「実行順序をどう保証するか」という課題に対し、GitHub Actionsを用いたCI環境の構築によって、コードのプッシュをトリガーとしたコンテナ起動からAnsible適用までのE2Eテストを扱いました。GitHub-hostedランナーに標準搭載されたDocker Engineを使うことで、CI上でも実際にコンテナを起動した検証が可能であることを、実機検証を交えて確認しました。

次回は、`null_resource`や`terraform_data`の`triggers`／`triggers_replace`を使い、設定ファイルに変更があった場合のみAnsibleを発火させる、不要な再実行を抑制する設計を扱います。

**[次回：第33回：`triggers`を用いたAnsible再実行の最適化設計](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part4/ansible-terraform-part4-33/)**

---

📑 連載の移動　**[前の記事：【Ansible×Terraform編】第31回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part4/ansible-terraform-part4-31/)　｜　[次の記事：【Ansible×Terraform編】第33回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part4/ansible-terraform-part4-33/)**

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

### 第4部：改善、CI/CD自動化編

|回数|テーマ、記事タイトル|概要|
|---|---|---|
|**[第31回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part4/ansible-terraform-part4-31/)**|状態出力を介した疎結合なパイプライン設計|Terraformの`output`を中間データ（JSON/Environment）として抽出し、Ansibleの動的インベントリや変数として渡すパイプラインの分離設計。|
|**[第32回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part4/ansible-terraform-part4-32/)**|GitHub Actionsを用いたプロビジョニングコードの自動テスト環境構築|CI/CD（GitHub Actions）上でTerraform実行によるコンテナ起動からAnsible適用までの自動テスト（E2E）を組み込む手法。|
|**[第33回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part4/ansible-terraform-part4-33/)**|`triggers`を用いたAnsible再実行の最適化設計|`null_resource`や`terraform_data`の`triggers`／`triggers_replace`を使い、設定ファイル変更時のみAnsibleを発火させる設計。|
|**[第34回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part4/ansible-terraform-part4-34/)**|Testinfraによる状態検証を組込んだCI/CDパイプライン|Ansible適用後の状態（ポート、ファイル、プロセス）をTestinfra（Python）でテストし、パイプラインの成否を判定する自動化設計。|
|**[第35回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part4/ansible-terraform-part4-35/)**|共通パーツのモジュール化（Terraformモジュール／Ansibleロール）|Terraformのモジュール設計とAnsibleのロール（Role/Collection）の粒度を揃え、再利用性を高める設計パターン。|
|**[第36回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part4/ansible-terraform-part4-36/)**|プラグインおよびパッケージのキャッシュによる開発効率の向上|Terraformのプラグインキャッシュとaptパッケージキャッシュにより、検証サイクルの待ち時間を短縮する手法。|
|**[第37回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part4/ansible-terraform-part4-37/)**|定期実行による構成ドリフトの自動検知と収束パイプライン|スケジュール実行（Cron／GitHub Actions）で`ansible-playbook --check`を流し、実際の構成差分（ドリフト）を検知し、差分があった場合のみ本実行して自動収束させる設計。|
|**[第38回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part4/ansible-terraform-part4-38/)**|インフラコード（HCL／Playbook）からの仕様書、構成図の自動生成|`terraform-docs`や`ansible-autodoc`等を活用し、コード更新と同時に仕様書や依存関係図を自動更新するパイプライン構築。|
|**[第39回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part4/ansible-terraform-part4-39/)**|既存インフラ運用知識とInfrastructure as Code（IaC）のシナジー|手動運用（CLI/Shell）のノウハウを、TerraformとAnsibleという2大ツールにどう分解、再構築していくかの比較考察。|
|**[第40回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part4/ansible-terraform-part4-40/)**|改善、CI/CD編まとめ：プロビジョニング自動化の成熟度モデル|手動実行から状態連携、CI/CD化、自動収束（Level 1〜4）に至るまでのインフラ自動化の成熟度の整理。|                                                |

---

[↑ 目次に戻る](#-目次)

---