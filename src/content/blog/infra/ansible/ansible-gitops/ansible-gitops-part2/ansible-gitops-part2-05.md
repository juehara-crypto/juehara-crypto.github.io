---
title: '「Ansible×TerraformをGitOpsで回す」〜Terraformプロバイダーを問わない構成管理の自動化〜 第5回：GitHub ActionsからAnsibleを実行する基本構成'
description: 'プルリクエストで確認し、マージで適用するGitOpsの基本の流れを、GitHub Actionsのself-hostedランナーの上に実装する。リポジトリをterraform/とansible/に分け、インベントリと鍵を実行時にtfstateから用意したうえで、変更されたパスによるジョブの切り替えと、Terraform→Ansibleの実行順序の保証を組む。暫定のまま残る部分と、AWS・GCPへの書き換え点もあわせて示す。'
pubDate: 2026-10-05
category: 'infra'
tags: ['Ansible', 'Terraform', 'GitOps', 'GitHub Actions', 'CI/CD']
seriesId: 'ansible-gitops-part2'
seriesNo: 5
prevPost: 'https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part1/ansible-gitops-part1-04/'
nextPost: 'https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-06/'
relatedSeries: ''
---

<style> table th, table td { word-break: normal; } table td:first-child { white-space: nowrap; } </style>


> **🗺️ 初めての方、シリーズの全体像を知りたい方はこちら**
>
> シリーズ全体については、以下のまとめブログで整理しています。
>
> → **「Ansible×TerraformをGitOpsで回す」〜Terraformプロバイダーを問わない構成管理の自動化〜 第2部まとめブログ：GitOpsパイプラインで「見たものだけが、承認したときだけ届く」仕組みを積み上げる** **※近日公開予定**

---

## 📋 目次

1. [はじめに](#1-はじめに)
2. [リポジトリをterraform/とansible/に分ける](#2-リポジトリをterraformとansibleに分ける)
3. [インベントリと鍵を実行時に生成する](#3-インベントリと鍵を実行時に生成する)
4. [プルリクエストで確認しマージで適用する](#4-プルリクエストで確認しマージで適用する)
5. [変更されたパスを判定する](#5-変更されたパスを判定する)
6. [TerraformからAnsibleへの実行順序を保証する](#6-terraformからansibleへの実行順序を保証する)
7. [この回の暫定構成と残る課題](#7-この回の暫定構成と残る課題)
8. [クラウドプロバイダーへの書き換え点](#8-クラウドプロバイダーへの書き換え点)
9. [まとめ](#9-まとめ)
10. [次回予告](#10-次回予告)
11. [連載一覧：「Ansible×TerraformをGitOpsで回す」](#11-連載一覧ansibleterraformをgitopsで回す)

---

## 1. はじめに

AnsibleとTerraformのコードを1つのGitリポジトリで管理し、GitHub Actionsでパイプラインを組んでいて、

* ワークフローに`terraform apply`と`ansible-playbook`を順番に並べた
* mainにマージすれば、両方が動いて変更が反映される
* これで、GitOpsのパイプラインはできている

と考えていないでしょうか。

CIでTerraformを実行する記事と、CIでAnsibleを実行する記事は、それぞれ数多くあります。一方で、両者を1本のパイプラインで扱い、コミットされた変更の内容に応じて動かし分ける構成は、あまり扱われていません。AnsibleとTerraformを1本のパイプラインで動かそうとすると、次のような場面にぶつかります。

* ワークフローにパスのフィルタを書いたが、Terraformのジョブだけ、Ansibleのジョブだけ、という切り替えができない
* パイプラインは緑で終わったのに、Ansibleはインベントリを読み込めず、1台にも接続していなかった
* プルリクエストを通さずにプッシュしたコミットまで、インフラに適用された

これらは、ワークフローの書き方の問題に見えます。共通しているのは、コミットされた変更に対して、どのジョブを、どの順序で動かし、その実行に必要な接続先をどこから用意するかが、パイプラインの構造として決まっていない点です。

パイプラインの構成は、「AnsibleとTerraformの連携が壊れる理由はライフサイクルにあった」（以下、Ansible×Terraformシリーズ）でも扱ってきました。Ansible×Terraformシリーズの **[第31回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part4/ansible-terraform-part4-31/)** では、Terraformの`local-exec`からAnsibleを直接実行する構成を見直し、Terraformの責務を状態（tfstate、`output`）の出力に限定しました。Ansibleは、`terraform output -json`を読み込む動的インベントリを使い、Terraformとは独立したタイミングで実行します。同じ回では、この疎結合化によって、`terraform apply`の完了とAnsibleの実行の順序をどう保証するかという、新しい設計課題が生じることを整理しました。**[第32回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part4/ansible-terraform-part4-32/)** と **[第37回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part4/ansible-terraform-part4-37/)** では、GitHub Actionsのワークフローで、Terraformによるコンテナの起動からAnsibleの適用、定期的なドリフトの検知までを実行しました。ただし、どちらもホステッドランナーの中にコンテナを作り、一連の処理を1回のワークフロー実行の中で完結させる構成でした。

本シリーズの第1部では、パイプラインを組むための前提を整理しました。**[第2回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part1/ansible-gitops-part1-02/)** では、コミットされる変更を3つに分類し、変更の種類ごとに必要な実行の順序を整理しました。同じ回で、AnsibleとTerraformの接続面であるIPアドレスはGitの外にあり、Gitで管理するのは値ではなく値の生成手順であることも確認しました。**[第3回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part1/ansible-gitops-part1-03/)** では、変更されたパスから、パイプラインがどのツールの判定から始めるかを決めるリポジトリの構造を設計し、リポジトリの`terraform/`と`ansible/`への再配置で決め直す点を洗い出しました。**[第4回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part1/ansible-gitops-part1-04/)** では、操作対象と同じネットワーク内に置くself-hostedランナーを、第2部以降の実行基盤に固定しました。

第2部（第5回〜 **[第12回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-12/)**）では、第1部の設計を、動くパイプラインとして実装し、安全に運用できる形まで積み上げていきます。第5回となる今回は、その骨格を作ります。**[第4回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part1/ansible-gitops-part1-04/)** で導入したself-hostedランナーの上で、リポジトリを`terraform/`と`ansible/`に分け、インベントリと鍵を実行時に用意したうえで、プルリクエストで確認し、マージで適用する流れを組みます。そのうえで、変更されたパスによるジョブの切り替えと、Terraform→Ansibleの実行順序の保証を実装します。骨格を先に動かすため、tfstateの置き場所（**[第6回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-06/)**）や機密情報の扱い（第3部、**[第13回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part3/ansible-gitops-part3-13/)** 〜 **[第16回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part3/ansible-gitops-part3-16/)**）などは暫定の構成とし、何が暫定のまま残るかも示します。

なお、第2部は、Ansible×Terraformシリーズ第4部と、**[「AnsibleのPlaybookが壊れる理由はテスト文化にあった」](https://qiita.com/juehara-crypto/items/194d5730466aef04ed44)**（以下、Moleculeシリーズ）と内容的なつながりがあります。Ansible×Terraformシリーズ第4部がGitHub ActionsでAnsibleとTerraformを動かすパイプラインを、Moleculeシリーズが変更のたびに確認し続ける仕組みを扱ったのに対し、第2部では、それらを、Gitに入った変更だけがインフラに届くパイプラインとして組み直します。これらのシリーズを読まれた方には答え合わせとして、初めて読まれる方には入り口として、読み進めていただける構成にしています。

正確に言うと、**パイプラインの骨格は、ジョブを並べることではなく、変更されたパスから「何を、どの順序で動かすか」を判定し、その実行に必要な接続先を、Gitの外から毎回用意する構造です**。この回で扱う問いは、「プルリクエストで確認し、マージで適用する基本の流れを、第1部で決めた分類、パス、順序に沿って、どう組むのか」です。

次のセクションでは、パイプラインが判定の入口に使うディレクトリ構成を、リポジトリに反映します。

---

[↑ 目次に戻る](#-目次)

---

## 2. リポジトリをterraform/とansible/に分ける

**[第3回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part1/ansible-gitops-part1-03/)** で設計したディレクトリ構成をリポジトリに反映し、再配置で決め直す点を実機で確認します。

### 移動前の構成と、決め直す点

**[第3回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part1/ansible-gitops-part1-03/)** のセクション6では、この検証環境のリポジトリは、`.github/workflows/`と`roles/`を除くすべてのファイルがルートに置かれていることを確認しました。Gitで管理しているファイル同士はツールをまたいで参照していませんが、Gitの外にある接続面（インベントリ、変数ファイル、生成した秘密鍵、tfstate）は、すべて同じルートにあることを前提に受け渡されています。同じ回で、再配置では次の点を決め直す必要があると洗い出しました。

* `docker_image`の`context = "."`の基準になる、`terraform`を実行する場所
* インベントリ、変数ファイル、生成した秘密鍵の書き出し先と、Ansibleがそれを読む場所
* `dynamic_inventory.py`が`terraform output`を実行する場所
* ワークフローの各ステップの作業ディレクトリ

ワークフローのトリガーを確認します。

**実行コマンド**

```plaintext
for f in .github/workflows/*.yml; do echo "== $f"; sed -n '/^on:/,/^jobs:/p' "$f"; done
```

**▼ 実行結果**

```plaintext
== .github/workflows/drift-check.yml
on:
  schedule:
    - cron: '0 * * * *'
  workflow_dispatch:
    inputs:
      simulate_tampering:
        description: '改ざんを注入するか'
        type: boolean
        default: true
jobs:
== .github/workflows/e2e-provisioning-test.yml
on:
  workflow_dispatch:

jobs:
```

`drift-check.yml`は、Ansible×Terraformシリーズの **[第37回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part4/ansible-terraform-part4-37/)** で作った定期検知のワークフローで、毎時の定期実行（`schedule`）が設定されています。どちらのワークフローも作業ディレクトリの指定がなく、`terraform init`や`ansible-playbook -i dynamic_inventory.py site.yml`をルートで実行しています。ファイルだけを移動してmainに入れると、次の定期実行からワークフローが動かなくなります。そのため、ファイルの移動とワークフローの修正は、同じコミットで行います。

移動前のベースラインとして、Terraformの差分とAnsibleの差分がないことを確認しておきます。

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

**実行コマンド**

```plaintext
ansible-playbook -i inventory.ini site.yml --check
```

**▼ 実行結果**

```plaintext
（途中省略：PLAYとTASKの表示、Pythonのインタープリターに関する警告）

PLAY RECAP **********************************************************************************************************************************************************************************
target-node1               : ok=2    changed=0    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
target-node2               : ok=2    changed=0    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
target-node3               : ok=2    changed=0    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
```

### ファイルの置き場所と、受け渡しの決め方

**[第3回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part1/ansible-gitops-part1-03/)** のセクション2の基準（そのファイルを読むツールで分ける）に従って、置き場所を次のように決めます。

|置き場所|ファイル|
|---|---|
|`terraform/`|`main.tf`、`outputs.tf`、`inventory.tftpl`、`group_vars_target_nodes.tftpl`、`Dockerfile`、`Dockerfile.deploy_nopasswd`、`Dockerfile.deploy_passwd`、`Dockerfile.legacy`、`id_ed25519.pub`、`.terraform.lock.hcl`|
|`ansible/`|`site.yml`、`roles/`、`ansible.cfg`、`dynamic_inventory.py`、`requirements.yml`、`.ansible-lint`|
|`tests/`|`test_target_node1.py`|
|ルート|`.gitignore`、`.github/workflows/`|

`test_target_node1.py`は、Testinfraによるテストで、TerraformもAnsibleも読みません。読むのはpytestなので、`tests/`に分けます。`tests/`だけの変更では、TerraformのジョブもAnsibleのジョブも動かす必要がない、というパスの判定にもつながります。

決め直す4点は、次のように決めます。

|決め直す点|決め方|
|---|---|
|`terraform`を実行する場所|`terraform/`で実行する。`context = "."`は変えず、`terraform/`を基準に解決させる|
|生成ファイルの書き出し先と、Ansibleが読む場所|Terraformが、Ansibleの側（`ansible/`）に書き出す。Ansibleは`ansible/`で実行し、`ansible.cfg`の`private_key_file = ./id_ed25519_generated`はそのまま使う|
|`dynamic_inventory.py`が`terraform output`を実行する場所|スクリプトの置き場所を基準に、`../terraform`で実行する|
|ワークフローの作業ディレクトリ|ステップごとに`working-directory`を指定する|

`main.tf`が`ansible/`に書き出すことは、**[第3回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part1/ansible-gitops-part1-03/)** のセクション2で示した「ツールをまたいでファイルを参照しない」という条件には反しません。この条件は、Gitで管理するファイルについてのものです。書き出すのはGitの外の接続面のファイルなので、変更されたパスによる判定には影響しません。

### ■ 検証内容：ファイルの移動と、受け渡し場所の修正

**[第3回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part1/ansible-gitops-part1-03/)** のセクション5で決めた原則に従い、作業用のブランチで変更し、プルリクエストを通してmainに入れます。まず、Gitで管理しているファイルを`git mv`で移動し、Gitの外にあるtfstate、`terraform.tfvars`、`.terraform/`も`terraform/`に移します。

**実行コマンド**

```plaintext
git switch -c gitops05-restructure
mkdir terraform ansible tests
git mv main.tf outputs.tf inventory.tftpl group_vars_target_nodes.tftpl Dockerfile Dockerfile.deploy_nopasswd Dockerfile.deploy_passwd Dockerfile.legacy id_ed25519.pub .terraform.lock.hcl terraform/
git mv site.yml roles ansible.cfg dynamic_inventory.py requirements.yml .ansible-lint ansible/
git mv test_target_node1.py tests/
mv terraform.tfstate terraform.tfstate.backup terraform.tfvars .terraform terraform/
```

あわせて、作業ディレクトリに残っていた不要なファイル（ワークフローのバックアップ、Pythonのキャッシュ）を削除しています。

次に、生成ファイルの書き出し先を変えます。**[第3回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part1/ansible-gitops-part1-03/)** のセクション6で確認した`main.tf`の123・132・153・158行目の`${path.module}/`を、`${path.module}/../ansible/`に変更しました。

**実行コマンド**

```plaintext
grep -n 'path\.module' terraform/main.tf
```

**▼ 実行結果**

```plaintext
104:    content = "${file("${path.module}/id_ed25519.pub")}\n${tls_private_key.generated.public_key_openssh}"
123:  filename = "${path.module}/../ansible/inventory.ini"
124:  content = templatefile("${path.module}/inventory.tftpl", {
132:  filename = "${path.module}/../ansible/group_vars/target_nodes.yml"
133:  content = templatefile("${path.module}/group_vars_target_nodes.tftpl", {
153:  filename = "${path.module}/../ansible/id_ed25519_generated"
158:    command = "chmod 0600 ${path.module}/../ansible/id_ed25519_generated"
```

104・124・133行目は、`terraform/`の中のファイル（公開鍵とテンプレート）を読む行なので、変えていません。

`dynamic_inventory.py`は、`terraform output`を実行する場所を、スクリプトの置き場所を基準にした`../terraform`に固定します。

* **ファイル名：`ansible/dynamic_inventory.py`（該当箇所）**

**【変更前】**

```python
result = subprocess.run(
    ["terraform", "output", "-json", "target_nodes"],
    capture_output=True, text=True
)
```

**【変更後】**

```python
result = subprocess.run(
    ["terraform", "output", "-json", "target_nodes"],
    capture_output=True, text=True,
    cwd=os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "terraform")
)
```

あわせて、`import subprocess`の次の行に`import os`を加えています。

2つのワークフローには、ステップごとに`working-directory`を加えました。`drift-check.yml`の差分は次のとおりです。

**実行コマンド**

```plaintext
git --no-pager diff -- .github/workflows/
```

**▼ 実行結果**

```plaintext
diff --git a/.github/workflows/drift-check.yml b/.github/workflows/drift-check.yml
index 50c1c70..2b9bd35 100644
--- a/.github/workflows/drift-check.yml
+++ b/.github/workflows/drift-check.yml
@@ -15,8 +15,10 @@ jobs:
       - uses: actions/checkout@v4
       - uses: hashicorp/setup-terraform@v3
       - name: Terraform Init
+        working-directory: terraform
         run: terraform init
       - name: Terraform Apply
+        working-directory: terraform
         env:
           TF_VAR_ansible_user_password: ${{ secrets.TF_VAR_ANSIBLE_USER_PASSWORD }}
           TF_VAR_deploy_user_password: ${{ secrets.TF_VAR_DEPLOY_USER_PASSWORD }}
@@ -28,16 +30,20 @@ jobs:
       - name: Install Ansible
         run: pip install ansible
       - name: Set executable permission for dynamic inventory
+        working-directory: ansible
         run: chmod +x dynamic_inventory.py
       - name: Run Ansible Playbook (initial provisioning)
+        working-directory: ansible
         run: ansible-playbook -i dynamic_inventory.py site.yml
       - name: Simulate manual tampering
         if: github.event.inputs.simulate_tampering != 'false'
+        working-directory: ansible
         run: |
           ssh -o StrictHostKeyChecking=no -i ./id_ed25519_generated -p 2231 ansible@127.0.0.1 \
             "sudo sed -i 's/ansible-drift-check/tampered/' /etc/drift-check-target.conf"
       - name: Ansible Check Mode
         id: check
+        working-directory: ansible
         run: |
           ansible-playbook -i dynamic_inventory.py site.yml --check | tee check_result.txt
           CHANGED=$(grep -oP 'changed=\K[0-9]+' check_result.txt | paste -sd+ -)
@@ -46,4 +52,5 @@ jobs:
           echo "DEBUG: CHANGED value is [$CHANGED]"
       - name: Apply if drift detected
         if: steps.check.outputs.changed != '0'
+        working-directory: ansible
         run: ansible-playbook -i dynamic_inventory.py site.yml
（途中省略：e2e-provisioning-test.ymlの差分）
```

`e2e-provisioning-test.yml`も同じように`working-directory`を加え、Testinfraのステップでは、鍵のパスを`./ansible/id_ed25519_generated`、テストのパスを`tests/test_target_node1.py`に変えました。

移動と修正の後の状態を確認します。

**実行コマンド**

```plaintext
git status
```

**▼ 実行結果**

```plaintext
On branch gitops05-restructure
Changes to be committed:
  (use "git restore --staged <file>..." to unstage)
        renamed:    .ansible-lint -> ansible/.ansible-lint
        renamed:    ansible.cfg -> ansible/ansible.cfg
        renamed:    dynamic_inventory.py -> ansible/dynamic_inventory.py
        renamed:    requirements.yml -> ansible/requirements.yml
        renamed:    roles/common_setup/tasks/drift_check.yml -> ansible/roles/common_setup/tasks/drift_check.yml
        renamed:    roles/common_setup/tasks/main.yml -> ansible/roles/common_setup/tasks/main.yml
        renamed:    site.yml -> ansible/site.yml
        renamed:    .terraform.lock.hcl -> terraform/.terraform.lock.hcl
        renamed:    Dockerfile -> terraform/Dockerfile
        renamed:    Dockerfile.deploy_nopasswd -> terraform/Dockerfile.deploy_nopasswd
        renamed:    Dockerfile.deploy_passwd -> terraform/Dockerfile.deploy_passwd
        renamed:    Dockerfile.legacy -> terraform/Dockerfile.legacy
        renamed:    group_vars_target_nodes.tftpl -> terraform/group_vars_target_nodes.tftpl
        renamed:    id_ed25519.pub -> terraform/id_ed25519.pub
        renamed:    inventory.tftpl -> terraform/inventory.tftpl
        renamed:    main.tf -> terraform/main.tf
        renamed:    outputs.tf -> terraform/outputs.tf
        renamed:    test_target_node1.py -> tests/test_target_node1.py

Changes not staged for commit:
  (use "git add <file>..." to update what will be committed)
  (use "git restore <file>..." to discard changes in working directory)
        modified:   .github/workflows/drift-check.yml
        modified:   .github/workflows/e2e-provisioning-test.yml
        modified:   ansible/dynamic_inventory.py
        modified:   terraform/main.tf
```

Gitで管理している18ファイルが移動し（`renamed`）、内容を変えたのは4ファイルです。

### ■ 検証内容：terraform/での計画と適用

`terraform/`に移動して初期化し、計画を確認します。

**実行コマンド**

```plaintext
cd ~/iac/docker-lab-ci/terraform
terraform init
```

**▼ 実行結果**

```plaintext
（途中省略：プロバイダーの再利用の表示）

Terraform has been successfully initialized!

（途中省略：初期化の後の案内）
```

**実行コマンド**

```plaintext
terraform plan
```

**▼ 実行結果**

```plaintext
（途中省略：Refreshing state...によるリソース一覧の出力）

Terraform used the selected providers to generate the following execution plan. Resource actions are indicated with the following symbols:
  + create

Terraform will perform the following actions:

  # local_file.ansible_inventory will be created
  + resource "local_file" "ansible_inventory" {
      + content              = <<-EOT
            [target_nodes]
            target-node1 ansible_host=172.19.0.3 ansible_user=ansible
            target-node2 ansible_host=172.19.0.4 ansible_user=ansible
            target-node3 ansible_host=172.19.0.2 ansible_user=ansible
        EOT
      + content_base64sha256 = (known after apply)
      + content_base64sha512 = (known after apply)
      + content_md5          = (known after apply)
      + content_sha1         = (known after apply)
      + content_sha256       = (known after apply)
      + content_sha512       = (known after apply)
      + directory_permission = "0777"
      + file_permission      = "0777"
      + filename             = "./../ansible/inventory.ini"
      + id                   = (known after apply)
    }

（途中省略：local_file.group_vars_target_nodesの作成計画）

  # local_file.private_key will be created
  + resource "local_file" "private_key" {
      + content              = (sensitive value)
      + content_base64sha256 = (known after apply)
      + content_base64sha512 = (known after apply)
      + content_md5          = (known after apply)
      + content_sha1         = (known after apply)
      + content_sha256       = (known after apply)
      + content_sha512       = (known after apply)
      + directory_permission = "0777"
      + file_permission      = "0777"
      + filename             = "./../ansible/id_ed25519_generated"
      + id                   = (known after apply)
    }

Plan: 3 to add, 0 to change, 0 to destroy.

（途中省略：区切り線と-outオプションに関する注意書き）
```

計画に現れたのは、書き出し先を変えた`local_file`の3つだけでした。コンテナ、イメージ、ネットワークは含まれていません。`context = "."`を変えずに、`terraform`を実行する場所を`terraform/`に移しても、イメージの差分は出ませんでした。

ただし、3つの`local_file`は、作り直し（`must be replaced`）ではなく、新規作成（`will be created`）として計画され、`0 to destroy`でした。この計画のまま適用します。

**実行コマンド**

```plaintext
terraform apply
```

**▼ 実行結果**

```plaintext
（途中省略：Refreshing state...と、計画の表示。計画は直前のterraform planと同じ）

Plan: 3 to add, 0 to change, 0 to destroy.

Do you want to perform these actions?
  Terraform will perform the actions described above.
  Only 'yes' will be accepted to approve.

  Enter a value: yes

local_file.private_key: Creating...
local_file.group_vars_target_nodes: Creating...
local_file.private_key: Creation complete after 0s [id=9eca59db64e7892b41b53f6ae80455475205b329]
local_file.ansible_inventory: Creating...
local_file.group_vars_target_nodes: Creation complete after 0s [id=56f3679bc6c6f1ab9cf3df9ea9b67cda4397491b]
local_file.ansible_inventory: Creation complete after 0s [id=cc4804cde5dbf9f41f0092633ac0f14765a9d661]

Apply complete! Resources: 3 added, 0 changed, 0 destroyed.

（途中省略：Outputsの表示）
```

書き出されたファイルと、ルートに残っているファイルを確認します。

**実行コマンド**

```plaintext
ls -l ../ansible ../ansible/group_vars
```

**▼ 実行結果**

```plaintext
../ansible:
total 32
-rw-rw-r-- 1 control control   79 Sep  2 08:34 ansible.cfg
-rwxrwxr-x 1 control control  822 Oct  5 06:00 dynamic_inventory.py
drwxrwxr-x 2 control control 4096 Oct  5 06:12 group_vars
-rwxrwxr-x 1 control control  387 Oct  5 06:12 id_ed25519_generated
-rwxrwxr-x 1 control control  189 Oct  5 06:12 inventory.ini
-rw-rw-r-- 1 control control   63 Aug 29 09:09 requirements.yml
drwxrwxr-x 3 control control 4096 Sep  4 07:09 roles
-rw-rw-r-- 1 control control  170 Sep  4 07:10 site.yml

../ansible/group_vars:
total 4
-rwxrwxr-x 1 control control 180 Oct  5 06:12 target_nodes.yml
```

**実行コマンド**

```plaintext
ls -l ../inventory.ini ../id_ed25519_generated ../group_vars
```

**▼ 実行結果**

```plaintext
-rw------- 1 control control  387 Sep 27 08:04 ../id_ed25519_generated
-rwxrwxr-x 1 control control  189 Oct  5 05:49 ../inventory.ini

../group_vars:
total 4
-rwxrwxr-x 1 control control 180 Oct  5 05:49 target_nodes.yml
```

この状態で、`ansible/`からAnsibleを実行します。

**実行コマンド**

```plaintext
cd ~/iac/docker-lab-ci/ansible
ansible-playbook -i inventory.ini site.yml --check
```

**▼ 実行結果**

```plaintext
PLAY [接続確認用Playbook] *******************************************************************************************************************************************************************

TASK [common_setup : ドリフト検知の実演用設定ファイルを配置] ********************************************************************************************************************************
fatal: [target-node1]: UNREACHABLE! => {"changed": false, "msg": "Failed to connect to the host via ssh: @@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@\r\n@         WARNING: UNPROTECTED PRIVATE KEY FILE!          @\r\n@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@\r\nPermissions 0775 for '/home/control/iac/docker-lab-ci/ansible/id_ed25519_generated' are too open.\r\nIt is required that your private key files are NOT accessible by others.\r\nThis private key will be ignored.\r\nLoad key \"/home/control/iac/docker-lab-ci/ansible/id_ed25519_generated\": bad permissions\r\nansible@172.19.0.3: Permission denied (publickey,password).", "unreachable": true}
（途中省略：target-node3、target-node2の同じ内容のエラー）

PLAY RECAP **********************************************************************************************************************************************************************************
target-node1               : ok=0    changed=0    unreachable=1    failed=0    skipped=0    rescued=0    ignored=0
target-node2               : ok=0    changed=0    unreachable=1    failed=0    skipped=0    rescued=0    ignored=0
target-node3               : ok=0    changed=0    unreachable=1    failed=0    skipped=0    rescued=0    ignored=0
```

最後に、tfstateに記録された`filename`を確認します。

**実行コマンド**

```plaintext
grep -n '"filename"' ~/iac/docker-lab-ci/terraform/terraform.tfstate
```

**▼ 実行結果**

```plaintext
837:            "filename": "./../ansible/inventory.ini",
879:            "filename": "./../ansible/group_vars/target_nodes.yml",
921:            "filename": "./../ansible/id_ed25519_generated",
```

### ■ 結果

移動後の`terraform/`での計画は、書き出し先を変えた`local_file`の3つの新規作成だけで、操作対象には影響しませんでした。一方、確認の中で2つのことが起きました。

1つ目は、古い場所のファイルが残ったことです。tfstateには、`filename`が`"./../ansible/inventory.ini"`のように、`terraform`を実行する場所からの相対パスで記録されています。移動前は、同じ`${path.module}/inventory.ini`が`./inventory.ini`として記録されていたことになります。`terraform`を実行する場所が`terraform/`に変わると、この相対パスが指すのは`terraform/inventory.ini`になり、そこにはファイルがありません。計画が作り直しではなく新規作成になり、ルートの古いファイルが削除されずに残ったのは、このためです。

2つ目は、Ansibleが接続できなくなったことです。新しく作られた秘密鍵の権限は`-rwxrwxr-x`（0775）で、SSHは「`Permissions 0775 ... are too open.`」として、この鍵を使いませんでした。ルートに残った古い鍵は`-rw-------`（0600）です。これまでは、`local_file`で鍵を書き出した後に、別のリソース（`null_resource.fix_permission`）の`chmod 0600`で権限を絞っていました。この`null_resource`は、作られたときに一度だけ`chmod`を実行するもので、今回のように`local_file`だけが作り直された場合には、計画に現れず、実行されませんでした。

どちらも、ファイルを移動しただけで起きています。再配置は、ファイルの置き場所の整理ではなく、Gitの外にある接続面を、どこで作り、どこで読み、どういう状態で受け渡すかを決め直す作業です。

### ■ 検証内容：秘密鍵の権限を、ファイルを作るリソースの属性で決める

鍵のファイルを作った後に、別の処理が権限を直す構造では、その処理が動かない経路で作り直されたとき、権限が抜け落ちます。そこで、権限を、鍵のファイルを作る`local_file.private_key`の属性（`file_permission`）として宣言し、役目がなくなる`null_resource.fix_permission`を削除します。

* **ファイル名：`terraform/main.tf`（該当箇所）**

**【変更前】**

```hcl
resource "local_file" "private_key" {
  filename = "${path.module}/../ansible/id_ed25519_generated"
  content  = tls_private_key.generated.private_key_openssh
}
resource "null_resource" "fix_permission" {
  provisioner "local-exec" {
    command = "chmod 0600 ${path.module}/../ansible/id_ed25519_generated"
  }

  depends_on = [local_file.private_key]
}
```

**【変更後】**

```hcl
resource "local_file" "private_key" {
  filename        = "${path.module}/../ansible/id_ed25519_generated"
  content         = tls_private_key.generated.private_key_openssh
  file_permission = "0600"
}
```

**実行コマンド**

```plaintext
cd ~/iac/docker-lab-ci/terraform
terraform plan
```

**▼ 実行結果**

```plaintext
（途中省略：Refreshing state...によるリソース一覧の出力）

Terraform used the selected providers to generate the following execution plan. Resource actions are indicated with the following symbols:
  - destroy
-/+ destroy and then create replacement

Terraform will perform the following actions:

  # local_file.private_key must be replaced
-/+ resource "local_file" "private_key" {
      （途中省略：content_base64sha256〜content_sha512のハッシュ値の差分）
      ~ file_permission      = "0777" -> "0600" # forces replacement
      ~ id                   = "9eca59db64e7892b41b53f6ae80455475205b329" -> (known after apply)
        # (3 unchanged attributes hidden)
    }

  # null_resource.fix_permission will be destroyed
  # (because null_resource.fix_permission is not in configuration)
  - resource "null_resource" "fix_permission" {
      - id = "7277059634623029921" -> null
    }

Plan: 1 to add, 0 to change, 2 to destroy.

（途中省略：区切り線と-outオプションに関する注意書き）
```

計画は、`file_permission`の変更による`local_file.private_key`の作り直しと、`null_resource.fix_permission`の破棄でした。鍵の中身を作る`tls_private_key.generated`は含まれていないため、鍵そのものは変わりません。この計画で適用します。

**実行コマンド**

```plaintext
terraform apply
```

**▼ 実行結果**

```plaintext
（途中省略：Refreshing state...と、計画の表示。計画は直前のterraform planと同じ）

Plan: 1 to add, 0 to change, 2 to destroy.

Do you want to perform these actions?
  Terraform will perform the actions described above.
  Only 'yes' will be accepted to approve.

  Enter a value: yes

null_resource.fix_permission: Destroying... [id=7277059634623029921]
null_resource.fix_permission: Destruction complete after 0s
local_file.private_key: Destroying... [id=9eca59db64e7892b41b53f6ae80455475205b329]
local_file.private_key: Destruction complete after 0s
local_file.private_key: Creating...
local_file.private_key: Creation complete after 0s [id=9eca59db64e7892b41b53f6ae80455475205b329]

Apply complete! Resources: 1 added, 0 changed, 2 destroyed.

（途中省略：Outputsの表示）
```

**実行コマンド**

```plaintext
ls -l ../ansible/id_ed25519_generated
```

**▼ 実行結果**

```plaintext
-rw------- 1 control control 387 Oct  5 06:31 ../ansible/id_ed25519_generated
```

**実行コマンド**

```plaintext
cd ~/iac/docker-lab-ci/ansible
ansible-playbook -i inventory.ini site.yml --check
```

**▼ 実行結果**

```plaintext
（途中省略：PLAYとTASKの表示、Pythonのインタープリターに関する警告）

PLAY RECAP **********************************************************************************************************************************************************************************
target-node1               : ok=2    changed=0    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
target-node2               : ok=2    changed=0    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
target-node3               : ok=2    changed=0    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
```

**実行コマンド**

```plaintext
cd ~/iac/docker-lab-ci/terraform
terraform plan
```

**▼ 実行結果**

```plaintext
（途中省略：Refreshing state...によるリソース一覧の出力）

No changes. Your infrastructure matches the configuration.

Terraform has compared your real infrastructure against your configuration and found no differences, so no changes are needed.
```

ルートに残った古いファイルは、Terraformの管理からも外れているため、手で削除します。

**実行コマンド**

```plaintext
cd ~/iac/docker-lab-ci
rm inventory.ini id_ed25519_generated
rm -r group_vars
```

**▼ 実行結果**

```plaintext
（出力なし）
```

### ■ 結果

鍵のファイルは、同じ`id`のまま、`-rw-------`（0600）で作り直されました。`ansible/`での`--check`は3台とも`changed=0`、`terraform/`での`terraform plan`は「No changes」となり、移動前のベースラインと同じ状態に戻りました。

権限を`local_file`の属性で宣言したことで、鍵のファイルは、どこで、何度作り直されても、同じ権限で作られます。作った後に別の処理で直す構造では、その処理が動かない経路が1つでもあれば、状態が抜け落ちます。この考え方は、**[セクション3](#3-インベントリと鍵を実行時に生成する)** で、パイプラインのジョブの中でインベントリと鍵を用意するときの前提になります。

### ■ 検証内容：mainへの反映と、既存のワークフローの確認

ここまでの変更を1つのコミットにし、作業用のブランチからプルリクエスト（`#1`）を作って、mainにマージしました。マージ後のmainの履歴と、Gitで管理しているファイルを確認します。

**実行コマンド**

```plaintext
git log --oneline --graph -4
```

**▼ 実行結果**

```plaintext
*   0136fa7 (HEAD -> main, origin/main) Merge pull request #1 from juehara-crypto/gitops05-restructure
|\
| * d4636db (origin/gitops05-restructure, gitops05-restructure) GitOps第5回: terraform/とansible/に再配置し、ワークフローの作業ディレクトリを修正
|/
* 180fd70 GitOps第4回: 検証用のワークフローを削除
* 4566ecb GitOps第4回: 操作対象の状態を読むワークフローを追加
```

**実行コマンド**

```plaintext
git ls-files
```

**▼ 実行結果**

```plaintext
.github/workflows/drift-check.yml
.github/workflows/e2e-provisioning-test.yml
.gitignore
ansible/.ansible-lint
ansible/ansible.cfg
ansible/dynamic_inventory.py
ansible/requirements.yml
ansible/roles/common_setup/tasks/drift_check.yml
ansible/roles/common_setup/tasks/main.yml
ansible/site.yml
terraform/.terraform.lock.hcl
terraform/Dockerfile
terraform/Dockerfile.deploy_nopasswd
terraform/Dockerfile.deploy_passwd
terraform/Dockerfile.legacy
terraform/group_vars_target_nodes.tftpl
terraform/id_ed25519.pub
terraform/inventory.tftpl
terraform/main.tf
terraform/outputs.tf
tests/test_target_node1.py
```

最後に、移動後のmain（`0136fa7`）で、`drift-check.yml`が動くかを確認します。定期実行と同じジョブを、GitHubのリポジトリの「Actions」タブから手動で起動しました（`workflow_dispatch`、「改ざんを注入するか」は既定のまま）。実行は成功し、ジョブのステップは次のとおりでした。

![移動後のmainで手動実行したDrift Checkのジョブのステップ一覧（全ステップ成功）](/images/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-05/section2-drift-check-steps.png)

ステップ「Ansible Check Mode」のログの末尾は、次のとおりです。

**▼ 実行結果（ステップ「Ansible Check Mode」から抜粋）**

```plaintext
（途中省略：PLAYとTASKの表示、Pythonのインタープリターに関する警告、PLAY RECAPの見出し行）
target-node1               : ok=2    changed=1    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
target-node2               : ok=2    changed=0    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
target-node3               : ok=2    changed=0    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0

DEBUG: CHANGED value is [1]
```

手動実行だけの`e2e-provisioning-test.yml`も、同じように手動で起動し、Testinfraによるテストまでのステップが、移動後の構成で成功することを確認しました。

### ■ 結果

`drift-check.yml`は、`terraform/`での`terraform init`と`terraform apply`、`ansible/`での`dynamic_inventory.py`によるインベントリの生成と`ansible-playbook`を、すべて新しい作業ディレクトリで実行しました。改ざんを注入したtarget-node1だけが`changed=1`として検知され、条件付きのステップ「Apply if drift detected」まで実行されています。ファイルの移動とワークフローの修正を同じコミットでmainに入れたことで、定期実行のワークフローも、移動の前後で動き続ける状態を保てました。

ここまでで、リポジトリは **[第3回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part1/ansible-gitops-part1-03/)** の設計どおりの構成になりました。ただし、インベントリと鍵は、手元で`terraform apply`を実行した作業ディレクトリにしかありません。パイプラインのジョブは、リポジトリをチェックアウトした別の場所で動くため、そこにはGitの外のファイルがありません。

次のセクションでは、パイプラインのジョブの中で、インベントリと鍵をどう用意するかを扱います。

---

[↑ 目次に戻る](#-目次)

---

## 3. インベントリと鍵を実行時に生成する

**[セクション2](#2-リポジトリをterraformとansibleに分ける)** で、リポジトリは`terraform/`と`ansible/`に分かれました。ただし、インベントリと鍵は、手元で`terraform apply`を実行した作業ディレクトリにしかありません。このセクションでは、パイプラインのジョブの中で、インベントリと鍵をどう用意するかを実機で確認します。

### ジョブが動く場所と、使える道具

**[第4回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part1/ansible-gitops-part1-04/)** で導入したself-hostedランナーが、ジョブをどこで、どの環境で実行するかを確認します。

**実行コマンド**

```plaintext
RUNNER_DIR=$(systemctl show -p WorkingDirectory --value actions.runner.juehara-crypto-ansible-terraform-ci-lab.ubuntu-controller.service)
echo "RUNNER_DIR=$RUNNER_DIR"
cat -n "$RUNNER_DIR/.path"
grep -n workFolder "$RUNNER_DIR/.runner"
```

**▼ 実行結果**

```plaintext
RUNNER_DIR=/home/control/actions-runner
     1  /usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/usr/games:/usr/local/games:/snap/bin
8:  "workFolder": "_work",
```

ジョブは、ランナーの作業フォルダ（`_work`）の下にリポジトリをチェックアウトして動きます。チェックアウト先の中身を確認します。

**実行コマンド**

```plaintext
ls -la ~/actions-runner/_work/ansible-terraform-ci-lab/ansible-terraform-ci-lab
```

**▼ 実行結果**

```plaintext
total 8
drwxr-xr-x 2 control control 4096 Oct  4 02:53 .
drwxr-xr-x 3 control control 4096 Oct  4 02:53 ..
```

チェックアウト先には、tfstateも生成ファイルもありません。ジョブがチェックアウトするのはGitで管理しているファイルだけなので、Gitの外にある接続面は、ジョブの中で毎回用意する必要があります。

ランナーのPATH（`.path`）は標準の場所だけで、Ansibleを入れたPython仮想環境（`~/ansible-env/bin`）は含まれていません。`terraform`は`/usr/bin/terraform`にあり、そのまま使えます。

**実行コマンド**

```plaintext
command -v terraform
ls -l ~/ansible-env/bin/ansible-playbook
```

**▼ 実行結果**

```plaintext
/usr/bin/terraform
-rwxrwxr-x 1 control control 188 Jul  2 08:50 /home/control/ansible-env/bin/ansible-playbook
```

ここから、ジョブの中で用意する方法を次のように決めます。

|用意するもの|方法|
|---|---|
|tfstateの参照|手元の`terraform/terraform.tfstate`を、パスを指定して読む。参照先は、ワークフローの環境変数1か所にまとめる|
|インベントリ|既存の`dynamic_inventory.py`を使い、`terraform output`にtfstateのパスを渡す|
|秘密鍵|`outputs.tf`に秘密鍵の出力（`sensitive = true`）を加え、ジョブの中で`terraform output -raw`から書き出す。書き出すときに権限を`0600`にする|
|`ansible-playbook`|ランナーのPATHに`~/ansible-env/bin`を加える|

tfstateの置き場所は、**[第6回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-06/)** で設計します。この回では、ランナーと同じホストにあるtfstateを、パスで直接読む暫定の構成にします。self-hostedランナーでは、実行に使う道具も、ランナーの側で用意する必要があります。

### ■ 検証内容：初期化されていない場所から、tfstateの出力を読む

ジョブのチェックアウト先と同じように、tfstateも`.terraform/`もない場所から、パスを指定して`terraform output`を読めるかを確認します。

**実行コマンド**

```plaintext
TMPDIR_CHECK=$(mktemp -d)
cd "$TMPDIR_CHECK"
ls -la
terraform output -state=/home/control/iac/docker-lab-ci/terraform/terraform.tfstate -json target_nodes; echo "exit_code=$?"
TF_CLI_ARGS_output="-state=/home/control/iac/docker-lab-ci/terraform/terraform.tfstate" terraform output -json target_nodes; echo "exit_code=$?"
```

**▼ 実行結果**

```plaintext
total 8
drwx------  2 control control 4096 Oct  5 08:49 .
drwxrwxrwt 15 root    root    4096 Oct  5 08:49 ..
{"target-node1":{"host":"172.19.0.3","port":22},"target-node2":{"host":"172.19.0.4","port":22},"target-node3":{"host":"172.19.0.2","port":22}}
exit_code=0
{"target-node1":{"host":"172.19.0.3","port":22},"target-node2":{"host":"172.19.0.4","port":22},"target-node3":{"host":"172.19.0.2","port":22}}
exit_code=0
```

2つ目は、環境変数`TF_CLI_ARGS_output`でパスを渡す方法です。この方法なら、`dynamic_inventory.py`が中で実行する`terraform output`にも、スクリプトを変えずにパスを渡せます。

次に、秘密鍵の出力を`outputs.tf`に加えます。

**実行コマンド**

```plaintext
cat -n terraform/outputs.tf
```

**▼ 実行結果**

```plaintext
     1  output "target_nodes" {
     2    value = {
     3      for name, container in docker_container.targets :
     4      name => {
     5        host = container.network_data[0].ip_address
     6        port = 22
     7      }
     8    }
     9    description = "Ansible接続用のホスト、ポート情報（動的インベントリ用）"
    10  }
    11
    12  output "generated_private_key" {
    13    value       = tls_private_key.generated.private_key_openssh
    14    sensitive   = true
    15    description = "Ansible接続用の秘密鍵（パイプラインのジョブで書き出す）"
    16  }
```

**実行コマンド**

```plaintext
cd ~/iac/docker-lab-ci/terraform
terraform plan
```

**▼ 実行結果**

```plaintext
（途中省略：Refreshing state...によるリソース一覧の出力）

Changes to Outputs:
  + generated_private_key = (sensitive value)

You can apply this plan to save these new output values to the Terraform state, without changing any real infrastructure.

（途中省略：区切り線と-outオプションに関する注意書き）
```

出力の追加だけで、インフラの変更はありません。出力の値をtfstateに記録するため、この計画で適用しました（`Apply complete! Resources: 0 added, 0 changed, 0 destroyed.`）。

初期化されていない場所から、出力の鍵を書き出します。書き出すときに`umask 077`で権限を`0600`にし、`ansible/`にある鍵と中身が同じかを`cmp`で比べます。鍵の中身は表示しません。

**実行コマンド**

```plaintext
TMPDIR_CHECK=$(mktemp -d)
cd "$TMPDIR_CHECK"
(umask 077; TF_CLI_ARGS_output="-state=/home/control/iac/docker-lab-ci/terraform/terraform.tfstate" terraform output -raw generated_private_key > id_ed25519_generated); echo "exit_code=$?"
ls -l id_ed25519_generated
cmp id_ed25519_generated ~/iac/docker-lab-ci/ansible/id_ed25519_generated; echo "cmp_exit_code=$?"
```

**▼ 実行結果**

```plaintext
（途中省略：terraform outputの終了コードの表示）
-rw------- 1 control control 387 Oct  5 08:53 id_ed25519_generated
cmp_exit_code=0
```

書き出した鍵は`-rw-------`で、`ansible/`の鍵と同じ中身でした。

### ■ 検証内容：ジョブの中でインベントリと鍵を用意する

確認用のワークフローを作業用のブランチに追加し、self-hostedランナーで動かします。このワークフローは、作業用のブランチへのプッシュで起動します。

* **ファイル名：`.github/workflows/runtime-inventory-check.yml`**

```yaml
name: Runtime Inventory Check

on:
  push:
    branches:
      - gitops05-runtime-inventory

env:
  TF_CLI_ARGS_output: -state=/home/control/iac/docker-lab-ci/terraform/terraform.tfstate

jobs:
  ansible-check:
    runs-on: [self-hosted, Linux, X64]
    steps:
      - uses: actions/checkout@v4
      - name: Add Ansible to PATH
        run: echo "$HOME/ansible-env/bin" >> "$GITHUB_PATH"
      - name: Show tool versions
        run: |
          terraform version
          ansible-playbook --version
      - name: Write private key from tfstate
        working-directory: ansible
        run: |
          umask 077
          terraform output -raw generated_private_key > id_ed25519_generated
          ls -l id_ed25519_generated
      - name: Show inventory
        working-directory: ansible
        run: ansible-inventory -i dynamic_inventory.py --graph
      - name: Ansible check mode
        working-directory: ansible
        run: ansible-playbook -i dynamic_inventory.py site.yml --check
      - name: Show git status
        if: always()
        run: git status --ignored --short --untracked-files=all
      - name: Remove private key
        if: always()
        working-directory: ansible
        run: rm -f id_ed25519_generated
```

最後の2つのステップには`if: always()`を付け、途中で失敗しても実行されるようにしています。self-hostedランナーでは、ジョブが終わっても作業フォルダが残るため、書き出した鍵はジョブの最後に削除します。

プッシュして起動した実行（`#1`）は、すべてのステップが成功しました。

![すべてのステップが成功した、確認用のワークフローの実行#1](/images/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-05/section3-runtime-inventory-steps.png)

しかし、ステップのログを開くと、内容は違っていました。

**▼ 実行結果（ステップ「Write private key from tfstate」）**

```plaintext
Run umask 077
-rw------- 1 control control 387 Oct  5 09:00 id_ed25519_generated
```

**▼ 実行結果（ステップ「Show inventory」から抜粋）**

```plaintext
Run ansible-inventory -i dynamic_inventory.py --graph
[WARNING]:  * Failed to parse /home/control/actions-runner/_work/ansible-
terraform-ci-lab/ansible-terraform-ci-lab/ansible/dynamic_inventory.py with
script plugin: Inventory script (/home/control/actions-runner/_work/ansible-
terraform-ci-lab/ansible-terraform-ci-lab/ansible/dynamic_inventory.py) had an
execution error: Traceback (most recent call last):   File
"/home/control/actions-runner/_work/ansible-terraform-ci-lab/ansible-terraform-
ci-lab/ansible/dynamic_inventory.py", line 14, in <module>     nodes =
json.loads(result.stdout)   File "/usr/lib/python3.10/json/__init__.py", line
346, in loads     return _default_decoder.decode(s)   File
"/usr/lib/python3.10/json/decoder.py", line 337, in decode     obj, end =
self.raw_decode(s, idx=_w(s, 0).end())   File
"/usr/lib/python3.10/json/decoder.py", line 355, in raw_decode     raise
JSONDecodeError("Expecting value", s, err.value) from None
json.decoder.JSONDecodeError: Expecting value: line 1 column 1 (char 0)
（途中省略：iniプラグインでの読み込みの失敗に関する警告）
[WARNING]: No inventory was parsed, only implicit localhost is available
@all:
  |--@ungrouped:
```

**▼ 実行結果（ステップ「Ansible check mode」から抜粋）**

```plaintext
Run ansible-playbook -i dynamic_inventory.py site.yml --check
（途中省略：「Show inventory」と同じインベントリの読み込みの失敗に関する警告）
[WARNING]: provided hosts list is empty, only localhost is available. Note that
the implicit localhost does not match 'all'
[WARNING]: Could not match supplied host pattern, ignoring: target_nodes

PLAY [接続確認用Playbook] ******************************************************
skipping: no hosts matched

PLAY RECAP *********************************************************************
```

**▼ 実行結果（ステップ「Show git status」）**

```plaintext
Run git status --ignored --short --untracked-files=all
!! ansible/id_ed25519_generated
```

鍵は`-rw-------`で書き出され、Gitの除外対象（`!!`）になっていました。一方、`dynamic_inventory.py`は`terraform output`から空の出力を受け取り、インベントリは空のままでした。Ansibleは「`skipping: no hosts matched`」で、1台にも接続せずに終わっています。それでも終了コードは成功扱いになり、ステップもジョブも緑になりました。

`terraform output`が空を返した理由を、チェックアウト先で同じコマンドを実行して確かめます。

**実行コマンド**

```plaintext
cd ~/actions-runner/_work/ansible-terraform-ci-lab/ansible-terraform-ci-lab/terraform
TF_CLI_ARGS_output="-state=/home/control/iac/docker-lab-ci/terraform/terraform.tfstate" terraform output -json target_nodes; echo "exit_code=$?"
```

**▼ 実行結果**

```plaintext
╷
│ Error: Required plugins are not installed
│
│ The installed provider plugins are not consistent with the packages selected in the dependency lock file:
│   - registry.terraform.io/hashicorp/local: there is no package for registry.terraform.io/hashicorp/local 2.9.0 cached in .terraform/providers
│   - registry.terraform.io/hashicorp/null: there is no package for registry.terraform.io/hashicorp/null 3.3.0 cached in .terraform/providers
│   - registry.terraform.io/hashicorp/tls: there is no package for registry.terraform.io/hashicorp/tls 4.3.0 cached in .terraform/providers
│   - registry.terraform.io/kreuzwerker/docker: there is no package for registry.terraform.io/kreuzwerker/docker 3.0.2 cached in .terraform/providers
│
│ Terraform uses external plugins to integrate with a variety of different infrastructure services. To download the plugins required for this configuration, run:
│   terraform init
╵
exit_code=1
```

### ■ 結果

鍵の書き出しは`ansible/`で、インベントリの`terraform output`は`dynamic_inventory.py`が`../terraform`で実行します。チェックアウト先の`terraform/`には`.tf`ファイルとロックファイルがありますが、初期化されていないため、`terraform output`はエラーで終わりました。このエラーは標準エラーに出るため、標準出力だけを読む`dynamic_inventory.py`には空の文字列が渡っていました。手元の事前確認では`.tf`ファイルのない一時フォルダから実行していたため、この違いに気づけませんでした。

ここで問題が大きいのは、`terraform output`の失敗そのものより、**インベントリが空のまま、ジョブが成功として終わったこと**です。パイプラインの画面だけを見ていれば、Ansibleが3台に適用されたと受け取ってしまいます。

### ■ 検証内容：インベントリを読み込めないときに、ジョブを失敗させる

先に、失敗が失敗として見えるようにします。Ansibleには、インベントリを読み込めなかったときの扱いを決める設定があります。

**実行コマンド**

```plaintext
~/ansible-env/bin/ansible-config list | grep -n -B10 'name: ANSIBLE_INVENTORY_UNPARSED_FAILED'
```

**▼ 実行結果**

```plaintext
2115-    section: inventory
2116-  name: Inventory ignore patterns
2117-  type: list
2118-INVENTORY_UNPARSED_IS_FAILED:
2119-  default: false
2120-  description: 'If ''true'' it is a fatal error if every single potential inventory
2121-    source fails to parse, otherwise, this situation will only attract a warning.
2122-
2123-    '
2124-  env:
2125:  - name: ANSIBLE_INVENTORY_UNPARSED_FAILED
```

既定値は`false`で、インベントリをすべて読み込めなくても、警告を出すだけで続行します。実行`#1`が緑で終わったのは、この既定の動きによるものです。`ansible.cfg`でこの設定を`True`にし、あわせて`dynamic_inventory.py`が`terraform output`の失敗を握りつぶさず、エラーの内容を出して終了するようにしました。

**実行コマンド**

```plaintext
git --no-pager show ebac881
```

**▼ 実行結果**

```plaintext
（途中省略：コミットの情報）

diff --git a/ansible/ansible.cfg b/ansible/ansible.cfg
index cfdea75..f42b929 100644
--- a/ansible/ansible.cfg
+++ b/ansible/ansible.cfg
@@ -1,3 +1,6 @@
 [defaults]
 host_key_checking = False
 private_key_file = ./id_ed25519_generated
+
+[inventory]
+unparsed_is_failed = True
diff --git a/ansible/dynamic_inventory.py b/ansible/dynamic_inventory.py
index 8c3f290..cba597c 100755
--- a/ansible/dynamic_inventory.py
+++ b/ansible/dynamic_inventory.py
@@ -2,6 +2,7 @@
 import json
 import subprocess
 import os
+import sys
 # result = subprocess.run(
 #    ["terraform", "output", "-json", "target_nodes"],
 #    capture_output=True, text=True, cwd="/home/control/iac/docker-lab"
@@ -11,6 +12,9 @@ result = subprocess.run(
     capture_output=True, text=True,
     cwd=os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "terraform")
 )
+if result.returncode != 0:
+    sys.stderr.write(result.stderr)
+    sys.exit(result.returncode)
 nodes = json.loads(result.stdout)
 inventory = {
     "target_nodes": {
```

チェックアウト先の`terraform/`は初期化しないまま、この変更をプッシュしました。実行（`#2`）は、「Show inventory」で失敗して止まりました。

![「Show inventory」で失敗した、確認用のワークフローの実行#2](/images/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-05/section3-runtime-inventory-failed.png)

**▼ 実行結果（ステップ「Show inventory」から抜粋）**

```plaintext
Run ansible-inventory -i dynamic_inventory.py --graph
[WARNING]:  * Failed to parse /home/control/actions-runner/_work/ansible-
terraform-ci-lab/ansible-terraform-ci-lab/ansible/dynamic_inventory.py with
script plugin: Inventory script (/home/control/actions-runner/_work/ansible-
terraform-ci-lab/ansible-terraform-ci-lab/ansible/dynamic_inventory.py) had an
execution error: ╷ │ Error:
Required plugins are not installed │  │
（途中省略：プロバイダーごとのエラーの内容）
  terraform init ╵
（途中省略：iniプラグインでの読み込みの失敗に関する警告）
ERROR! No inventory was parsed, please check your configuration and options.
Error: Process completed with exit code 1.
```

### ■ 結果

実行`#1`では緑のまま素通りしていた同じ状態が、実行`#2`では赤になりました。ログには`terraform output`のエラーがそのまま表示され、原因（`terraform init`が必要）まで画面で読めます。「Ansible check mode」は実行されず、`if: always()`を付けた「Show git status」と「Remove private key」は、失敗の後も実行されています。

### ■ 検証内容：ジョブの中で、terraform/を初期化してからインベントリを読む

チェックアウト先の`terraform/`を初期化するステップを、鍵とインベントリを読む前に加えます。

* **ファイル名：`.github/workflows/runtime-inventory-check.yml`（追加したステップ）**

```yaml
      - name: Terraform init
        working-directory: terraform
        run: terraform init -input=false
```

実行（`#3`）は、すべてのステップが成功しました。

![terraform initを加えて成功した、確認用のワークフローの実行#3](/images/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-05/section3-runtime-inventory-success.png)

**▼ 実行結果（ステップ「Show inventory」）**

```plaintext
Run ansible-inventory -i dynamic_inventory.py --graph
@all:
  |--@ungrouped:
  |--@target_nodes:
  |  |--target-node1
  |  |--target-node2
  |  |--target-node3
```

**▼ 実行結果（ステップ「Ansible check mode」から抜粋）**

```plaintext
Run ansible-playbook -i dynamic_inventory.py site.yml --check

PLAY [接続確認用Playbook] ******************************************************

（途中省略：TASKの表示、Pythonのインタープリターに関する警告）

PLAY RECAP *********************************************************************
target-node1               : ok=2    changed=0    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0   
target-node2               : ok=2    changed=0    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0   
target-node3               : ok=2    changed=0    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0   
```

インベントリに3台が入り、Ansibleは3台とも`changed=0`で終わりました。ただし、「Show git status」には、もう1つ変化が出ていました。

**▼ 実行結果（ステップ「Show git status」）**

```plaintext
Run git status --ignored --short --untracked-files=all
 M terraform/.terraform.lock.hcl
!! ansible/id_ed25519_generated
!! terraform/.terraform/providers/registry.terraform.io/hashicorp/local/2.9.0/linux_amd64
!! terraform/.terraform/providers/registry.terraform.io/hashicorp/tls/4.3.0/linux_amd64
!! terraform/.terraform/providers/registry.terraform.io/kreuzwerker/docker/3.0.2/linux_amd64
```

### ■ 検証内容：ジョブの中でロックファイルを書き換えない

ジョブの`terraform init`が、チェックアウト先のロックファイルを書き換えていました。チェックアウト先で、その差分を確認します。

**実行コマンド**

```plaintext
cd ~/actions-runner/_work/ansible-terraform-ci-lab/ansible-terraform-ci-lab
git --no-pager diff terraform/.terraform.lock.hcl
```

**▼ 実行結果**

```plaintext
diff --git a/terraform/.terraform.lock.hcl b/terraform/.terraform.lock.hcl
index 029145c..1b11592 100644
--- a/terraform/.terraform.lock.hcl
+++ b/terraform/.terraform.lock.hcl
@@ -21,26 +21,6 @@ provider "registry.terraform.io/hashicorp/local" {
   ]
 }

-provider "registry.terraform.io/hashicorp/null" {
-  version = "3.3.0"
（途中省略：hashicorp/nullのハッシュ値）
-  ]
-}
-
 provider "registry.terraform.io/hashicorp/tls" {
   version     = "4.3.0"
   constraints = "~> 4.0"
```

**[セクション2](#2-リポジトリをterraformとansibleに分ける)** で`null_resource.fix_permission`を削除したため、設定から`null`プロバイダーを使うリソースがなくなりました。それなのに、リポジトリのロックファイルには`hashicorp/null`が残っていました。手元の`terraform/`では、**[セクション2](#2-リポジトリをterraformとansibleに分ける)** の後に`terraform init`をし直していなかったため、このずれに気づけませんでした。ジョブの`terraform init`は、使われなくなった`null`の項目を削除していたことになります。

ロックファイルは、使うプロバイダーとそのバージョンを固定するためのファイルです。ジョブの中で書き換わると、リポジトリにあるロックファイルと、実際に使われたプロバイダーが食い違います。そこで、次の2つを行いました。

* 手元の`terraform/`で`terraform init`を実行し、リポジトリのロックファイルから`hashicorp/null`を外してコミットする。差分は、ジョブで出たものと同じでした
* ジョブの`terraform init`に`-lockfile=readonly`を付け、ジョブの中ではロックファイルを書き換えないようにする

**実行コマンド**

```plaintext
git --no-pager diff .github/workflows/runtime-inventory-check.yml
```

**▼ 実行結果**

```plaintext
diff --git a/.github/workflows/runtime-inventory-check.yml b/.github/workflows/runtime-inventory-check.yml
index 189b5df..c8bbc3e 100644
--- a/.github/workflows/runtime-inventory-check.yml
+++ b/.github/workflows/runtime-inventory-check.yml
@@ -21,7 +21,7 @@ jobs:
           ansible-playbook --version
       - name: Terraform init
         working-directory: terraform
-        run: terraform init -input=false
+        run: terraform init -input=false -lockfile=readonly
       - name: Write private key from tfstate
         working-directory: ansible
         run: |
```

この変更をプッシュした実行（`#4`）では、「Show git status」から、ロックファイルの変更が消えました。

**▼ 実行結果（ステップ「Show git status」）**

```plaintext
Run git status --ignored --short --untracked-files=all
!! ansible/id_ed25519_generated
!! terraform/.terraform/providers/registry.terraform.io/hashicorp/local/2.9.0/linux_amd64
!! terraform/.terraform/providers/registry.terraform.io/hashicorp/tls/4.3.0/linux_amd64
!! terraform/.terraform/providers/registry.terraform.io/kreuzwerker/docker/3.0.2/linux_amd64
```

### ■ 検証内容：mainへの反映

確認用のワークフローは、作業用のブランチへのプッシュでしか起動しないため、マージの前に削除しました。ここで確かめたステップは、**[セクション4](#4-プルリクエストで確認しマージで適用する)** で作るワークフローに組み込みます。残りの変更をプルリクエスト（`#2`）にし、mainにマージしました。

**実行コマンド**

```plaintext
git log --oneline --graph -7
```

**▼ 実行結果**

```plaintext
*   563700a (HEAD -> main, origin/main) Merge pull request #2 from juehara-crypto/gitops05-runtime-inventory
|\
| * 1bd26c1 GitOps第5回: 確認用のワークフローを削除
| * 05cc8fd GitOps第5回: ロックファイルを設定に合わせ、ジョブではロックファイルを書き換えない
| * b8c9178 GitOps第5回: ジョブの中でterraform/を初期化してからインベントリを読む
| * ebac881 GitOps第5回: インベントリを読み込めないときにジョブを失敗させる
| * d11abc9 GitOps第5回: ジョブの中でtfstateからインベントリと鍵を用意する確認用のワークフローを追加
|/
*   0136fa7 Merge pull request #1 from juehara-crypto/gitops05-restructure
|\
```

`ansible.cfg`と`dynamic_inventory.py`は、定期検知の`drift-check.yml`も使うファイルです。マージ後のmain（`563700a`）で`drift-check.yml`を手動で実行し、成功することを確認しました。

**▼ 実行結果（ステップ「Ansible Check Mode」から抜粋）**

```plaintext
（途中省略：PLAYとTASKの表示、Pythonのインタープリターに関する警告）

PLAY RECAP *********************************************************************
target-node1               : ok=2    changed=1    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0   
target-node2               : ok=2    changed=0    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0   
target-node3               : ok=2    changed=0    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0   

DEBUG: CHANGED value is [1]
```

### ■ 結果

パイプラインのジョブの中で、インベントリと鍵を、Gitに置かずにtfstateから毎回用意できるようになりました。インベントリは`dynamic_inventory.py`が`terraform output`から作り、鍵はジョブの中で`terraform output -raw`から`0600`で書き出し、ジョブの最後に削除します。どちらも、Terraformのジョブが動いたかどうかに関係なく、Ansibleを動かす前に用意できます。

確認の中で分かったのは、次の3点です。

* ジョブの中で`terraform`のコマンドを使うときは、`.tf`ファイルのある場所を初期化しておく必要がある。事前の確認は、ジョブと同じ条件の場所で行わないと、違いを見落とす
* インベントリを読み込めなくても、Ansibleの既定の動きでは成功として終わる。パイプラインでは、`unparsed_is_failed`で失敗させ、失敗を画面で見えるようにする
* ジョブの中の`terraform init`は、ロックファイルを書き換えることがある。`-lockfile=readonly`で、ロックファイルを変えてよいのはレビューを通ったコミットだけにする

1つ目と3つ目は、ジョブの中の作業ディレクトリが、手元の作業ディレクトリとは別物であることから来ています。2つ目は、パイプラインでは「成功と表示された」ことと「意図した対象に適用された」ことが別だ、ということです。

次のセクションでは、この仕組みを、プルリクエストで確認しマージで適用するワークフローに組み込みます。

---

[↑ 目次に戻る](#-目次)

---

## 4. プルリクエストで確認しマージで適用する

**[セクション3](#3-インベントリと鍵を実行時に生成する)** で、ジョブの中でインベントリと鍵を用意できるようになりました。このセクションでは、プルリクエストでは確認系（`terraform plan`、`ansible-playbook --check`）を、mainへのプッシュ（マージ）では適用系（`terraform apply`、`ansible-playbook`）を実行するワークフローを組みます。

### ジョブと同じ条件では、変更がなくても差分が出る

適用系をジョブで動かす前に、ジョブと同じ条件での`terraform plan`を確認します。ジョブのチェックアウト先と同じ状態を作るため、手元のリポジトリを一時フォルダに複製し、tfstateとパスワードはパスで渡します。手元の`terraform/`での計画は「No changes」です。

**実行コマンド**

```plaintext
TMPDIR_CHECK=$(mktemp -d)
git clone -q ~/iac/docker-lab-ci "$TMPDIR_CHECK/repo"
cd "$TMPDIR_CHECK/repo/terraform"
terraform init -input=false -lockfile=readonly > /dev/null; echo "init_exit_code=$?"
terraform plan -input=false \
  -state=/home/control/iac/docker-lab-ci/terraform/terraform.tfstate \
  -var-file=/home/control/iac/docker-lab-ci/terraform/terraform.tfvars
```

**▼ 実行結果**

```plaintext
init_exit_code=0
╷
│ Warning: Deprecated flag: -state
│
│ Use the "path" attribute within the "local" backend to specify a file for state storage
╵
（途中省略：Refreshing state...によるリソース一覧の出力）

Terraform used the selected providers to generate the following execution plan. Resource actions are indicated with the following symbols:
  + create

Terraform will perform the following actions:

  # local_file.ansible_inventory will be created
  + resource "local_file" "ansible_inventory" {
（途中省略：内容の表示）
      + filename             = "./../ansible/inventory.ini"
      + id                   = (known after apply)
    }

  # local_file.group_vars_target_nodes will be created
（途中省略：内容の表示）

  # local_file.private_key will be created
（途中省略：内容の表示）

Plan: 3 to add, 0 to change, 0 to destroy.

（途中省略：区切り線と-outオプションに関する注意書き）
```

コンテナ、イメージ、ネットワークに差分はありません。しかし、`local_file`の3つが、毎回「作成」として計画されます。**[セクション2](#2-リポジトリをterraformとansibleに分ける)** で確認したとおり、`local_file`の`filename`はtfstateに相対パスで記録されています。複製したリポジトリの`ansible/`にはGitの外の生成ファイルがないため、Terraformは毎回「ファイルがない」と判断します。

このままパイプラインに載せると、次のことが起きます。

* プルリクエストの`terraform plan`が、変更がなくても毎回「3 to add」になり、本当の変更が毎回の差分に埋もれる
* マージのたびに`terraform apply`がファイルを作り直し、秘密鍵がランナーの作業フォルダに書き出されたまま残る

**[セクション3](#3-インベントリと鍵を実行時に生成する)** で、インベントリは`dynamic_inventory.py`、鍵は`generated_private_key`の出力から用意できるようになりました。パイプラインの中では、`local_file`の役目はもうありません。`local_file`がどこで使われているかを確認します。

**実行コマンド**

```plaintext
grep -rn -E 'nginx_settings|inventory\.ini|id_ed25519_generated|group_vars' ansible/ tests/ .github/
```

**▼ 実行結果**

```plaintext
ansible/ansible.cfg:3:private_key_file = ./id_ed25519_generated
ansible/group_vars/target_nodes.yml:2:nginx_settings:
.github/workflows/drift-check.yml:42:          ssh -o StrictHostKeyChecking=no -i ./id_ed25519_generated -p 2231 ansible@127.0.0.1 \
.github/workflows/e2e-provisioning-test.yml:51:            --ssh-identity-file=./ansible/id_ed25519_generated \
```

変数ファイル（`nginx_settings`）は、生成されたファイル自身のほかに参照がなく、PlaybookもRoleも使っていません。インベントリ（`inventory.ini`）は、ワークフローからは参照されていません。鍵は、`ansible.cfg`と2つの既存のワークフローが使っています。`ansible.cfg`は、ジョブの中で同じ場所に鍵を書き出せばそのまま使えます。2つのワークフローには、出力から鍵を書き出すステップを加えます。

### ■ 検証内容：local_fileによる受け渡しをやめる

`main.tf`から`local_file`の3つを削除し、使われなくなったテンプレート（`inventory.tftpl`、`group_vars_target_nodes.tftpl`）も削除しました。

**実行コマンド**

```plaintext
cd ~/iac/docker-lab-ci/terraform
terraform plan
```

**▼ 実行結果**

```plaintext
（途中省略：Refreshing state...によるリソース一覧の出力）

Terraform used the selected providers to generate the following execution plan. Resource actions are indicated with the following symbols:
  - destroy

Terraform will perform the following actions:

  # local_file.ansible_inventory will be destroyed
  # (because local_file.ansible_inventory is not in configuration)
（途中省略：内容の表示）

  # local_file.group_vars_target_nodes will be destroyed
  # (because local_file.group_vars_target_nodes is not in configuration)
（途中省略：内容の表示）

  # local_file.private_key will be destroyed
  # (because local_file.private_key is not in configuration)
（途中省略：内容の表示）

Plan: 0 to add, 0 to change, 3 to destroy.

（途中省略：区切り線と-outオプションに関する注意書き）
```

計画は`local_file`の3つの破棄だけで、鍵そのものを作る`tls_private_key.generated`や、コンテナは含まれていません。この計画で適用し（`Apply complete! Resources: 0 added, 0 changed, 3 destroyed.`）、手元の`ansible/`にあった3つのファイルが削除されました。手元でも、ジョブと同じ方法で鍵を書き出し、`dynamic_inventory.py`で接続します。

**実行コマンド**

```plaintext
cd ~/iac/docker-lab-ci/ansible
(umask 077; terraform -chdir=../terraform output -raw generated_private_key > id_ed25519_generated)
ls -l id_ed25519_generated
ansible-playbook -i dynamic_inventory.py site.yml --check
```

**▼ 実行結果**

```plaintext
-rw------- 1 control control 387 Oct  5 10:59 id_ed25519_generated

（途中省略：PLAYとTASKの表示、Pythonのインタープリターに関する警告）

PLAY RECAP **********************************************************************************************************************************************************************************
target-node1               : ok=2    changed=0    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
target-node2               : ok=2    changed=0    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
target-node3               : ok=2    changed=0    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
```

変更をコミットし、もう一度、複製したリポジトリで計画を確認しました。

**▼ 実行結果（複製したリポジトリでのterraform init -lockfile=readonly）**

```plaintext
╷
│ Error: Provider dependency changes detected
│
│ Changes to the required provider dependencies were detected, but the lock file is read-only. To use and record these requirements, run "terraform init" without the "-lockfile=readonly"
│ flag.
╵
init_exit_code=1
```

`local_file`をすべて削除したため、`hashicorp/local`プロバイダーを使うリソースがなくなりました。**[セクション3](#3-インベントリと鍵を実行時に生成する)** で`null`の項目がジョブの中で黙って削除されたのと同じ種類のずれが、今回は`-lockfile=readonly`によって失敗として見えています。手元の`terraform/`で`terraform init`を実行し、ロックファイルから`hashicorp/local`のブロックを外してコミットしました。

**▼ 実行結果（ロックファイルを直した後、複製したリポジトリでのterraform plan）**

```plaintext
init_exit_code=0
╷
│ Warning: Deprecated flag: -state
│
│ Use the "path" attribute within the "local" backend to specify a file for state storage
╵
（途中省略：Refreshing state...によるリソース一覧の出力）

No changes. Your infrastructure matches the configuration.

Terraform has compared your real infrastructure against your configuration and found no differences, so no changes are needed.
```

ジョブと同じ条件でも、変更がなければ差分のない計画になりました。`-state`の非推奨の警告は、tfstateの置き場所を設計する **[第6回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-06/)** まで残します。

既存の2つのワークフローには、鍵を出力から書き出すステップを加えました。

**実行コマンド**

```plaintext
git --no-pager diff .github/workflows/drift-check.yml
```

**▼ 実行結果**

```plaintext
diff --git a/.github/workflows/drift-check.yml b/.github/workflows/drift-check.yml
index 2b9bd35..fdfb52f 100644
--- a/.github/workflows/drift-check.yml
+++ b/.github/workflows/drift-check.yml
@@ -32,6 +32,12 @@ jobs:
       - name: Set executable permission for dynamic inventory
         working-directory: ansible
         run: chmod +x dynamic_inventory.py
+      - name: Write private key from tfstate
+        working-directory: ansible
+        run: |
+          umask 077
+          terraform -chdir=../terraform output -raw generated_private_key > id_ed25519_generated
+          ls -l id_ed25519_generated
       - name: Run Ansible Playbook (initial provisioning)
         working-directory: ansible
         run: ansible-playbook -i dynamic_inventory.py site.yml
```

`e2e-provisioning-test.yml`にも、同じステップを加えています。マージの前に、作業用のブランチで2つのワークフローを手動で実行しました。`drift-check.yml`では、書き出した鍵による改ざんの注入が効き、target-node1が`changed=1`として検知されました。`e2e-provisioning-test.yml`では、書き出した鍵でTestinfraが接続し、「`6 passed`」でした。

### ワークフローの構成

プルリクエストとmainへのプッシュで、別々のジョブを動かします。

|きっかけ|ジョブ|実行する内容|
|---|---|---|
|mainへのプルリクエスト|`check`|`terraform plan`→鍵の書き出し→`ansible-playbook --check`|
|mainへのプッシュ（マージ）|`apply`|`terraform apply`→鍵の書き出し→`ansible-playbook`|

* **ファイル名：`.github/workflows/gitops-pipeline.yml`**

```yaml
name: GitOps Pipeline

on:
  pull_request:
    branches:
      - main
  push:
    branches:
      - main

env:
  TF_VAR_ansible_user_password: ${{ secrets.TF_VAR_ANSIBLE_USER_PASSWORD }}
  TF_VAR_deploy_user_password: ${{ secrets.TF_VAR_DEPLOY_USER_PASSWORD }}

jobs:
  check:
    if: github.event_name == 'pull_request'
    runs-on: [self-hosted, Linux, X64]
    env:
      TF_CLI_ARGS_plan: -state=/home/control/iac/docker-lab-ci/terraform/terraform.tfstate
      TF_CLI_ARGS_output: -state=/home/control/iac/docker-lab-ci/terraform/terraform.tfstate
    steps:
      - uses: actions/checkout@v4
      - name: Add Ansible to PATH
        run: echo "$HOME/ansible-env/bin" >> "$GITHUB_PATH"
      - name: Terraform init
        working-directory: terraform
        run: terraform init -input=false -lockfile=readonly
      - name: Terraform plan
        working-directory: terraform
        run: terraform plan -input=false
      - name: Write private key from tfstate
        working-directory: ansible
        run: |
          umask 077
          terraform -chdir=../terraform output -raw generated_private_key > id_ed25519_generated
      - name: Ansible check mode
        working-directory: ansible
        run: ansible-playbook -i dynamic_inventory.py site.yml --check
      - name: Remove private key
        if: always()
        working-directory: ansible
        run: rm -f id_ed25519_generated

  apply:
    if: github.event_name == 'push'
    runs-on: [self-hosted, Linux, X64]
    env:
      TF_CLI_ARGS_apply: -state=/home/control/iac/docker-lab-ci/terraform/terraform.tfstate
      TF_CLI_ARGS_output: -state=/home/control/iac/docker-lab-ci/terraform/terraform.tfstate
    steps:
      - uses: actions/checkout@v4
      - name: Add Ansible to PATH
        run: echo "$HOME/ansible-env/bin" >> "$GITHUB_PATH"
      - name: Terraform init
        working-directory: terraform
        run: terraform init -input=false -lockfile=readonly
      - name: Terraform apply
        working-directory: terraform
        run: terraform apply -input=false -auto-approve
      - name: Write private key from tfstate
        working-directory: ansible
        run: |
          umask 077
          terraform -chdir=../terraform output -raw generated_private_key > id_ed25519_generated
      - name: Ansible playbook
        working-directory: ansible
        run: ansible-playbook -i dynamic_inventory.py site.yml
      - name: Remove private key
        if: always()
        working-directory: ansible
        run: rm -f id_ed25519_generated
```

どちらのジョブも、TerraformとAnsibleを1つのジョブの中で順番に実行します。ジョブを分けて順序を保証する構成は、**[セクション6](#6-terraformからansibleへの実行順序を保証する)** で扱います。鍵の書き出しは、Terraformのステップの後に置きました。`terraform apply`で鍵が作り直された場合でも、新しい鍵を使うためです。tfstateのパスは`TF_CLI_ARGS_plan`、`TF_CLI_ARGS_apply`、`TF_CLI_ARGS_output`で渡し、パスワードは既存のワークフローと同じSecretsから渡します。

### ■ 検証内容：プルリクエストで確認する

ここまでの変更を作業用のブランチにコミットし、mainへのプルリクエスト（`#3`）を作成しました。このプルリクエストをきっかけに、「GitOps Pipeline」の実行（`#1`）が起動しました。画像のタイトルの横にある`#`の番号は、プルリクエストの番号ではなく、ワークフローの実行の番号です。実行の番号は、すべてのプルリクエストとプッシュを通して振られるため、プルリクエストの番号とは一致しません。

![プルリクエスト#3で起動した実行#1。checkが成功し、applyはスキップされている](/images/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-05/section4-pr-run.png)

**▼ 実行結果（checkジョブのステップ「Terraform plan」から抜粋）**

```plaintext
Run terraform plan -input=false
╷
│ Warning: Deprecated flag: -state
│ 
│ Use the "path" attribute within the "local" backend to specify a file for
│ state storage
╵
（途中省略：Refreshing state...によるリソース一覧の出力）

No changes. Your infrastructure matches the configuration.

Terraform has compared your real infrastructure against your configuration
and found no differences, so no changes are needed.
```

**▼ 実行結果（checkジョブのステップ「Ansible check mode」から抜粋）**

```plaintext
（途中省略：コマンドと環境変数の表示、PLAYとTASKの表示、Pythonのインタープリターに関する警告）

PLAY RECAP *********************************************************************
target-node1               : ok=2    changed=0    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0   
target-node2               : ok=2    changed=0    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0   
target-node3               : ok=2    changed=0    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
```

プルリクエストでは`check`だけが動き、`apply`はスキップされました。`pull_request`をきっかけに動くワークフローは、プルリクエストのブランチではなく、mainにマージした結果（`refs/pull/プルリクエストの番号/merge`）に対して実行されます（**[GitHub Docs：Events that trigger workflows](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows)**）。このプルリクエストで追加したワークフローのファイルが、このプルリクエスト自身の確認で動いたのはこのためです。

### ■ 検証内容：マージで適用する

プルリクエスト`#3`をマージしました（マージコミット`3c18314`）。このマージがmainへのプッシュとなり、「GitOps Pipeline」の実行（`#2`）が起動しました。

![プルリクエスト#3のマージで起動した実行#2。applyが成功し、checkはスキップされている](/images/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-05/section4-merge-run.png)

**▼ 実行結果（applyジョブのステップ「Terraform apply」から抜粋）**

```plaintext
Run terraform apply -input=false -auto-approve
（途中省略：-stateの非推奨の警告、Refreshing state...によるリソース一覧の出力）

No changes. Your infrastructure matches the configuration.

Terraform has compared your real infrastructure against your configuration
and found no differences, so no changes are needed.

Apply complete! Resources: 0 added, 0 changed, 0 destroyed.

（途中省略：Outputsの表示）
```

**▼ 実行結果（applyジョブのステップ「Ansible playbook」から抜粋）**

```plaintext
（途中省略：コマンドの表示、PLAYとTASKの表示、Pythonのインタープリターに関する警告）

PLAY RECAP *********************************************************************
target-node1               : ok=2    changed=0    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0   
target-node2               : ok=2    changed=0    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0   
target-node3               : ok=2    changed=0    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0   
```

マージでは`apply`だけが動き、`check`はスキップされました。`local_file`がなくなったため、マージのたびにファイルを作り直すこともなくなっています。

### ■ 検証内容：直接プッシュでも適用される

**[第3回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part1/ansible-gitops-part1-03/)** のセクション5で確認したとおり、この検証環境では、mainへの直接プッシュを止められません。この構成で、プルリクエストを通さずにmainへプッシュしたコミットがどう扱われるかを確かめます。インフラにも設定にも影響しない、空のコミットを使います。

**実行コマンド**

```plaintext
git commit --allow-empty -m "GitOps第5回: 直接プッシュで適用系が動くことの確認（空のコミット）"
git push origin main; echo "exit_code=$?"
```

**▼ 実行結果**

```plaintext
[main adf9a4d] GitOps第5回: 直接プッシュで適用系が動くことの確認（空のコミット）
（途中省略：オブジェクトの送信の表示）
To https://github.com/juehara-crypto/ansible-terraform-ci-lab.git
   3c18314..adf9a4d  main -> main
exit_code=0
```

このプッシュでも「GitOps Pipeline」の実行（`#3`）が起動し、`check`はスキップされ、`apply`が成功しました。

![直接プッシュで起動した実行#3。checkはスキップされ、applyが成功している](/images/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-05/section4-direct-push-run.png)

### ■ 結果

プルリクエストでは`check`が、マージでは`apply`が動き、「mainに入ったコミットが、あるべき状態として適用される」流れが、ワークフローのトリガーの構造として動きました。プルリクエストの確認は、マージした結果に対して行われるため、マージ後に適用される内容を、マージ前に確かめられます。

一方、プルリクエストを通さずに直接プッシュしたコミット（`adf9a4d`）でも、`apply`はそのまま動きました。ワークフローが見ているのは「mainにプッシュされた」ことだけで、そのコミットがプルリクエストを通ったかどうかは見ていません。この構成で「プルリクエストで確認したものだけが適用される」とは、まだ言えません。適用の前に、プルリクエストを通ったコミットかを確かめる仕組みは、**[第7回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-07/)** と **[第8回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-08/)** で扱います。

また、ジョブと同じ条件で計画を確かめたことで、`local_file`による受け渡しが、パイプラインでは毎回の差分を生むことが分かりました。手元の作業ディレクトリでは「No changes」でも、ジョブの中では違う結果になります。パイプラインに載せる前の確認は、ジョブと同じ条件で行う必要があります。

ここまでの構成では、`terraform/`だけの変更でも、`ansible/`だけの変更でも、TerraformとAnsibleの両方が動きます。次のセクションでは、変更されたパスを判定し、何を動かすかを決める仕組みを扱います。

---

[↑ 目次に戻る](#-目次)

---

## 5. 変更されたパスを判定する

**[セクション4](#4-プルリクエストで確認しマージで適用する)** の構成では、`terraform/`だけの変更でも、`ansible/`だけの変更でも、TerraformとAnsibleの両方が動きます。**[第3回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part1/ansible-gitops-part1-03/)** のセクション2では、変更されたパスから、パイプラインがどのツールの判定から始めるかを決めました。このセクションでは、その判定をワークフローとして実装し、判定の結果を確認します。判定の結果でジョブを切り替えるのは、**[セクション6](#6-terraformからansibleへの実行順序を保証する)** で扱います。

### パスのフィルタは、ワークフロー単位の判定

GitHub Actionsには、変更されたパスでワークフローを動かすかどうかを決める`paths`フィルタがあります。公式ドキュメントでは、`push`と`pull_request`のイベントで「少なくとも1つのパスがフィルタのパターンに一致すれば、ワークフローが動く」と説明されています（**[GitHub Docs：Workflow syntax for GitHub Actions](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax)**）。

`paths`フィルタが決めるのは、ワークフロー全体を動かすかどうかだけです。ジョブ単位の`paths`フィルタはありません。`terraform/`と`ansible/`の両方をフィルタに書いても、どちらかに一致すればワークフローが動き、その中のジョブはすべて動きます。「Terraformのジョブだけ」「Ansibleのジョブだけ」という切り替えは、`paths`フィルタではできません。

ジョブ単位で切り替えるには、変更されたパスを判定するジョブを別に用意し、その結果を出力（`outputs`）として後のジョブに渡します。後のジョブは、`needs`で判定のジョブを指定し、`if`で出力を見て、動くかどうかを決めます。

### 判定の方法

変更されたファイルを、`git diff --name-only`で2つのコミットを比べて調べます。外部のアクションは使わず、Gitのコマンドだけで判定します。比べる2つのコミットは、ワークフローのきっかけによって変えます。

|きっかけ|比べる2つのコミット|
|---|---|
|プルリクエスト|プルリクエストのマージ先のコミット（`github.event.pull_request.base.sha`）と、マージした結果（`github.sha`）|
|mainへのプッシュ|プッシュの前のコミット（`github.event.before`）と、プッシュの後のコミット（`github.sha`）|

プッシュで「プッシュの前」と比べるのは、直接プッシュで複数のコミットがまとめて送られた場合も、すべての変更を拾うためです。**[セクション4](#4-プルリクエストで確認しマージで適用する)** で確認したとおり、この構成では直接プッシュも適用されるため、判定もその場合に備えておく必要があります。

### ■ 検証内容：パスを判定するジョブを加える

`gitops-pipeline.yml`に、変更されたパスを判定する`changes`ジョブを加えました。`check`と`apply`は変えていません。

* **ファイル名：`.github/workflows/gitops-pipeline.yml`（追加したジョブ）**

```yaml
  changes:
    runs-on: [self-hosted, Linux, X64]
    outputs:
      terraform: ${{ steps.filter.outputs.terraform }}
      ansible: ${{ steps.filter.outputs.ansible }}
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - name: Detect changed paths
        id: filter
        env:
          BASE_SHA: ${{ github.event_name == 'pull_request' && github.event.pull_request.base.sha || github.event.before }}
          HEAD_SHA: ${{ github.sha }}
        run: |
          git diff --name-only "$BASE_SHA" "$HEAD_SHA" | tee "$RUNNER_TEMP/changed_files.txt"
          if grep -q '^terraform/' "$RUNNER_TEMP/changed_files.txt"; then
            echo "terraform=true" >> "$GITHUB_OUTPUT"
          else
            echo "terraform=false" >> "$GITHUB_OUTPUT"
          fi
          if grep -q '^ansible/' "$RUNNER_TEMP/changed_files.txt"; then
            echo "ansible=true" >> "$GITHUB_OUTPUT"
          else
            echo "ansible=false" >> "$GITHUB_OUTPUT"
          fi
          cat "$GITHUB_OUTPUT"
```

2つのコミットを比べるには、チェックアウトでその2つの履歴を取得しておく必要があるため、`fetch-depth: 0`で全履歴を取得しています。判定の結果は`terraform`と`ansible`の2つの出力にし、後のジョブから使えるようにしました。

この変更をプルリクエスト（`#4`）にしました。このプルリクエストで起動した実行の判定は、次のとおりです。

**▼ 実行結果（プルリクエスト#4、ステップ「Detect changed paths」から抜粋）**

```plaintext
（途中省略：実行したスクリプトと、環境変数の表示）
    BASE_SHA: adf9a4d26a53c79e641f99e1659c310953ed7ff4
    HEAD_SHA: cfbc551585d3edc90e1c99f319791650e2bbf348
.github/workflows/gitops-pipeline.yml
terraform=false
***=false
```

最後の行の`***`は、出力の名前の`ansible`です。GitHub Actionsは、Secretsの値と一致する文字列を、ログの中で`***`に置き換えて表示します。この検証環境では、パスワードに、ユーザー名などログに頻繁に現れる語と同じ値を使っています。そのため、ログの中の`ansible`という語が、パスワードとは関係のない箇所まですべて伏せられています。伏せられるのはログの表示だけで、出力の値には影響しません。

これは、パスワードの値そのものが、ログの伏せられ方から推測できてしまう状態でもあります。Secretsに入れた値は、ログで伏せられるから安全、とは限りません。パスワードを含む機密情報の扱いは、第3部（**[第13回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part3/ansible-gitops-part3-13/)** 〜 **[第16回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part3/ansible-gitops-part3-16/)**）で扱います。

`BASE_SHA`はmainの`adf9a4d`、`HEAD_SHA`はプルリクエストをmainにマージした結果のコミットです。このプルリクエストの変更はワークフローのファイルだけなので、`terraform`も`ansible`も`false`と判定されました。

プルリクエスト`#4`をマージした後の、プッシュでの判定は次のとおりです。

**▼ 実行結果（マージ後のプッシュ、ステップ「Detect changed paths」から抜粋）**

```plaintext
（途中省略：実行したスクリプトと、環境変数の表示）
    BASE_SHA: adf9a4d26a53c79e641f99e1659c310953ed7ff4
    HEAD_SHA: 4b1053e3810c2121a0e6f4cd40061ffd5ad14d82
.github/workflows/gitops-pipeline.yml
terraform=false
***=false
```

プッシュでは、`BASE_SHA`がプッシュの前のmain（`adf9a4d`）、`HEAD_SHA`がマージコミット（`4b1053e`）になり、プルリクエストのときと同じ判定になりました。

### ■ 検証内容：3つのパターンでの判定

mainから3つのブランチを作り、それぞれコメント行を1行加えて、プルリクエストを作りました。コメント行なので、Terraformの計画にもAnsibleの実行にも差分は出ません。

|プルリクエスト|変更したファイル|
|---|---|
|`#5`|`terraform/main.tf`だけ|
|`#6`|`ansible/site.yml`だけ|
|`#7`|`terraform/main.tf`と`ansible/site.yml`の両方|

`#7`の実行の判定は、次のとおりです。

**▼ 実行結果（プルリクエスト#7、ステップ「Detect changed paths」から抜粋）**

```plaintext
（途中省略：実行したスクリプトと、環境変数の表示）
    BASE_SHA: 4b1053e3810c2121a0e6f4cd40061ffd5ad14d82
    HEAD_SHA: 5b9d3c197fbae0aaf328b9443a6fcbd6e85e6e19
***/site.yml
terraform/main.tf
terraform=true
***=true
```

ここでも、`ansible/site.yml`のパスと、出力の名前の`ansible`が伏せられています。3つのプルリクエストの判定をまとめると、次のとおりです。

|プルリクエスト|変更されたファイル|`terraform`|`ansible`|
|---|---|---|---|
|`#5`|`terraform/main.tf`|`true`|`false`|
|`#6`|`ansible/site.yml`|`false`|`true`|
|`#7`|`ansible/site.yml`、`terraform/main.tf`|`true`|`true`|

3つのプルリクエストは、判定の確認のためのものなので、マージせずに閉じました。

### ■ 結果

変更されたパスから、`terraform/`と`ansible/`のそれぞれに変更があったかを、プルリクエストでもプッシュでも判定できるようになりました。ワークフローのファイルだけの変更は、どちらにも該当しないと判定されます。

この判定が **[第3回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part1/ansible-gitops-part1-03/)** の表どおりに使えるのは、リポジトリが、ファイルを読むツールで`terraform/`と`ansible/`に分かれているからです。**[セクション2](#2-リポジトリをterraformとansibleに分ける)** で再配置し、**[セクション4](#4-プルリクエストで確認しマージで適用する)** で`local_file`による受け渡しをやめたことで、TerraformとAnsibleの間でGitのファイルを参照し合うことはなくなりました。AnsibleがTerraformから受け取るのは、tfstateの出力（接続先と鍵）だけで、これはGitの外にあります。そのため、`ansible/`だけの変更でTerraformの判定を省いても、Terraformの側に影響が漏れません。

ただし、判定の結果を出力しただけでは、まだ何も切り替わっていません。`check`と`apply`は、判定の結果に関係なく、これまでどおりTerraformとAnsibleの両方を実行しています。次のセクションでは、判定の結果を受け取って、TerraformとAnsibleのジョブを切り替え、その実行順序を保証します。

---

[↑ 目次に戻る](#-目次)

---

## 6. TerraformからAnsibleへの実行順序を保証する

**[セクション5](#5-変更されたパスを判定する)** で、変更されたパスから`terraform`と`ansible`の2つの判定を出力できるようになりました。このセクションでは、その判定でTerraformとAnsibleのジョブを切り替え、Terraform→Ansibleの実行順序を保証します。

### Terraformが動いたら、Ansibleも必ず後続で動かす

**[第2回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part1/ansible-gitops-part1-02/)** では、再生成を伴うTerraformの変更では、作り直したリソースにPlaybookの全タスクを適用し直す必要があることを確認しました。そこで、この回の構成では、次の方針でジョブを切り替えます。

* `terraform/`に変更があれば、Terraformのジョブを動かし、その後にAnsibleのジョブを**必ず**動かす
* `ansible/`だけに変更があれば、Ansibleのジョブだけを動かす

**[第3回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part1/ansible-gitops-part1-03/)** の表では、`terraform/`配下の変更は、`terraform plan`の結果を見てAnsibleの要否を決めるとしました。この回の構成は、その判定を省き、Terraformが動いたら常にAnsibleも動かす、安全側に倒した単純化です。planの結果からAnsibleの要否や作り直しを読み取る仕組みは、**[第9回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-09/)** で扱います。

ジョブの構成は、次のとおりです。

|きっかけ|ジョブ|動く条件|
|---|---|---|
|プルリクエスト|`terraform-plan`|`terraform/`に変更あり|
|プルリクエスト|`ansible-check`（`terraform-plan`の後）|`terraform/`か`ansible/`に変更あり|
|mainへのプッシュ|`terraform-apply`|`terraform/`に変更あり|
|mainへのプッシュ|`ansible-apply`（`terraform-apply`の後）|`terraform/`か`ansible/`に変更あり|

Ansibleのジョブの条件に`terraform/`の変更を含めているのが、「Terraformが動いたらAnsibleも必ず動く」の部分です。順序は、Ansibleのジョブの`needs`にTerraformのジョブを指定して保証します。

### ■ 検証内容：ジョブを分け、needsで順序を指定する

**[セクション4](#4-プルリクエストで確認しマージで適用する)** の`check`と`apply`を、TerraformとAnsibleの4つのジョブに分けました。`changes`ジョブは、**[セクション5](#5-変更されたパスを判定する)** のものをそのまま使います。

* **ファイル名：`.github/workflows/gitops-pipeline.yml`（`changes`より後のジョブ）**

```yaml
  terraform-plan:
    needs: changes
    if: github.event_name == 'pull_request' && needs.changes.outputs.terraform == 'true'
    runs-on: [self-hosted, Linux, X64]
    env:
      TF_CLI_ARGS_plan: -state=/home/control/iac/docker-lab-ci/terraform/terraform.tfstate
    steps:
      - uses: actions/checkout@v4
      - name: Terraform init
        working-directory: terraform
        run: terraform init -input=false -lockfile=readonly
      - name: Terraform plan
        working-directory: terraform
        run: terraform plan -input=false

  ansible-check:
    needs: [changes, terraform-plan]
    if: github.event_name == 'pull_request' && (needs.changes.outputs.terraform == 'true' || needs.changes.outputs.ansible == 'true')
    runs-on: [self-hosted, Linux, X64]
    env:
      TF_CLI_ARGS_output: -state=/home/control/iac/docker-lab-ci/terraform/terraform.tfstate
    steps:
      - uses: actions/checkout@v4
      - name: Add Ansible to PATH
        run: echo "$HOME/ansible-env/bin" >> "$GITHUB_PATH"
      - name: Terraform init
        working-directory: terraform
        run: terraform init -input=false -lockfile=readonly
      - name: Write private key from tfstate
        working-directory: ansible
        run: |
          umask 077
          terraform -chdir=../terraform output -raw generated_private_key > id_ed25519_generated
      - name: Ansible check mode
        working-directory: ansible
        run: ansible-playbook -i dynamic_inventory.py site.yml --check
      - name: Remove private key
        if: always()
        working-directory: ansible
        run: rm -f id_ed25519_generated

  terraform-apply:
    needs: changes
    if: github.event_name == 'push' && needs.changes.outputs.terraform == 'true'
    （途中省略：terraform-planと同じ構成で、TF_CLI_ARGS_applyとterraform apply -input=false -auto-approveを実行する）

  ansible-apply:
    needs: [changes, terraform-apply]
    if: github.event_name == 'push' && (needs.changes.outputs.terraform == 'true' || needs.changes.outputs.ansible == 'true')
    （途中省略：ansible-checkと同じ構成で、--checkを付けずにansible-playbookを実行する）
```

Ansibleのジョブでは、`ansible/`だけの変更の場合もtfstateの出力を読むため、`terraform/`の初期化を行います。

作業用のブランチから、`terraform/`だけ、`ansible/`だけ、両方を変更する3つのブランチを作り、それぞれのプルリクエストで、どのジョブが動くかを確認しました。変更はコメント行1行の追加だけです。

|プルリクエスト|変更|`terraform-plan`|`ansible-check`|
|---|---|---|---|
|`#8`|`terraform/`だけ|成功|成功|
|`#9`|`ansible/`だけ|スキップ|**スキップ**|
|`#10`|両方|成功|成功|

`ansible/`だけを変更した`#9`の実行（`#10`）で、`ansible-check`までスキップされました。表の番号はプルリクエストの番号で、画像のタイトルの横にある番号は、ワークフローの実行の番号です。実行の番号は、すべてのプルリクエストとプッシュを通して振られるため、プルリクエストの番号とは一致しません。

![ansible/だけを変更したプルリクエスト#9の実行#10。ansible-checkまでスキップされている](/images/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-05/section6-ansible-only-before.png)

### ■ 結果

公式ドキュメントでは、`needs`について「ジョブが失敗またはスキップされると、そのジョブを必要とするジョブは、処理を続ける条件式を使わない限り、すべてスキップされる」と説明されています（**[GitHub Docs：Workflow syntax for GitHub Actions](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax)**）。`ansible/`だけの変更では、`terraform-plan`が条件によってスキップされ、それを`needs`で指定している`ansible-check`も、自分の条件を評価される前にスキップされました。

しかも、この実行の結果は「Success」でした。Ansibleの確認が一度も動いていないのに、プルリクエストには成功の印が付きます。**[セクション3](#3-インベントリと鍵を実行時に生成する)** で見た「緑なのに、Ansibleが1台にも接続していない」と同じ種類の問題です。順序を保証するために`needs`を使うと、順序の前にあるジョブがスキップされたとき、後のジョブまで黙って動かなくなります。

### ■ 検証内容：Terraformのジョブがスキップされても、Ansibleのジョブを動かす

`ansible-check`と`ansible-apply`の`if`を、次のように書き直しました。

**実行コマンド**

```plaintext
git --no-pager diff
```

**▼ 実行結果**

```plaintext
diff --git a/.github/workflows/gitops-pipeline.yml b/.github/workflows/gitops-pipeline.yml
index 153ae08..0b75c57 100644
--- a/.github/workflows/gitops-pipeline.yml
+++ b/.github/workflows/gitops-pipeline.yml
@@ -58,7 +58,7 @@ jobs:
 
   ansible-check:
     needs: [changes, terraform-plan]
-    if: github.event_name == 'pull_request' && (needs.changes.outputs.terraform == 'true' || needs.changes.outputs.ansible == 'true')
+    if: ${{ !cancelled() && github.event_name == 'pull_request' && needs.terraform-plan.result != 'failure' && (needs.changes.outputs.terraform == 'true' || needs.changes.outputs.ansible == 'true') }}
     runs-on: [self-hosted, Linux, X64]
     env:
       TF_CLI_ARGS_output: -state=/home/control/iac/docker-lab-ci/terraform/terraform.tfstate
@@ -99,7 +99,7 @@ jobs:
 
   ansible-apply:
     needs: [changes, terraform-apply]
-    if: github.event_name == 'push' && (needs.changes.outputs.terraform == 'true' || needs.changes.outputs.ansible == 'true')
+    if: ${{ !cancelled() && github.event_name == 'push' && needs.terraform-apply.result != 'failure' && (needs.changes.outputs.terraform == 'true' || needs.changes.outputs.ansible == 'true') }}
     runs-on: [self-hosted, Linux, X64]
     env:
       TF_CLI_ARGS_output: -state=/home/control/iac/docker-lab-ci/terraform/terraform.tfstate
```

加えた条件は、次の2つです。

|条件|意味|
|---|---|
|`!cancelled()`|前のジョブがスキップされても、このジョブの条件の評価を続ける。ワークフローが取り消されたときは動かない|
|`needs.terraform-plan.result != 'failure'`（適用側は`terraform-apply`）|Terraformのジョブが**失敗**したときは動かない。スキップされたときは動く|

`!cancelled()`だけでは、Terraformのジョブが失敗しても、Ansibleのジョブが動いてしまいます。Terraformの計画や適用が失敗した状態でAnsibleを動かさないため、2つ目の条件を加えています。`!`で始まる式は、YAMLの文法と区別するため、`${{ }}`で囲んでいます。

この修正を3つのブランチに取り込んでプッシュし、`#8`〜`#10`のそれぞれで新しい実行を起動して、もう一度確認しました。あわせて、`terraform/main.tf`に文法の誤りを入れたプルリクエスト（`#11`）を作り、Terraformのジョブが失敗した場合も確認しました。

|プルリクエスト|変更|`terraform-plan`|`ansible-check`|
|---|---|---|---|
|`#8`|`terraform/`だけ|成功|成功|
|`#9`|`ansible/`だけ|スキップ|**成功**|
|`#10`|両方|成功|成功|
|`#11`|`terraform/`の文法の誤り|**失敗**|**スキップ**|

`ansible/`だけを変更した`#9`の実行（`#13`）では、`terraform-plan`がスキップされても、`ansible-check`が動きました。

![ansible/だけを変更したプルリクエスト#9の実行#13。terraform-planがスキップされてもansible-checkが動いている](/images/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-05/section6-ansible-only-after.png)

文法の誤りを入れた`#11`の実行（`#15`）では、`terraform-plan`が失敗し、`ansible-check`は動きませんでした。

![文法の誤りを入れたプルリクエスト#11の実行#15。terraform-planが失敗し、ansible-checkは動いていない](/images/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-05/section6-terraform-fail.png)

`terraform-plan`が失敗したのは、「Terraform init」のステップでした。

**▼ 実行結果（プルリクエスト#11、terraform-planジョブのステップ「Terraform init」）**

```plaintext
Run terraform init -input=false -lockfile=readonly
╷
│ Error: Terraform encountered problems during initialisation, including problems
│ with the configuration, described below.
│ 
│ The Terraform configuration must be valid before initialization so that
│ Terraform can determine which modules and providers need to be installed.
│ 
│ 
╵
╷
│ Error: Unsupported block type
│ 
│   on main.tf line 133:
│  133: this is not valid hcl
│ 
│ Blocks of type "this" are not expected here.
╵
╷
│ Error: Invalid block definition
│ 
│   on main.tf line 133:
│  133: this is not valid hcl
│ 
│ A block definition must have block content delimited by "{" and "}",
│ starting on the same line as the block header.
╵
Error: Process completed with exit code 1.
```

`.tf`ファイルの文法の誤りは、`terraform init`の段階で検出されました。どのステップで失敗しても、`terraform-plan`ジョブの結果は`failure`になり、`ansible-check`は動きません。ワークフロー全体も「Failure」になり、プルリクエストには失敗の印が付きました。`#8`、`#9`、`#11`は、確認のためのプルリクエストなので、マージせずに閉じています。`#10`は、この後のmainへのプッシュでの確認に使います。

### ■ 検証内容：mainへのプッシュでの順序

ワークフローの変更をプルリクエスト（`#12`）にしてマージしました（マージコミット`bcba046`）。このプルリクエストの変更はワークフローのファイルだけなので、プルリクエストでも、マージ後のプッシュでも、`changes`以外の4つのジョブはすべてスキップされました。

続いて、両方を変更した`#10`をマージしました（マージコミット`a8c0365`）。このプッシュで、「GitOps Pipeline」の実行（`#19`）が起動しました。

![プルリクエスト#10のマージで起動した実行#19。terraform-applyの後にansible-applyが動いている](/images/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-05/section6-push-both.png)

**▼ 実行結果（terraform-applyジョブのステップ「Terraform apply」から抜粋）**

```plaintext
Run terraform apply -input=false -auto-approve
（途中省略：-stateの非推奨の警告、Refreshing state...によるリソース一覧の出力）

No changes. Your infrastructure matches the configuration.

Terraform has compared your real infrastructure against your configuration
and found no differences, so no changes are needed.

Apply complete! Resources: 0 added, 0 changed, 0 destroyed.

（途中省略：Outputsの表示）
```

**▼ 実行結果（ansible-applyジョブのステップ「Ansible playbook」から抜粋）**

```plaintext
（途中省略：コマンドの表示、PLAYとTASKの表示、Pythonのインタープリターに関する警告）

PLAY RECAP *********************************************************************
target-node1               : ok=2    changed=0    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0   
target-node2               : ok=2    changed=0    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0   
target-node3               : ok=2    changed=0    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0   
```

`terraform-apply`の後に`ansible-apply`が動き、どちらも変更なしで終わりました。

最後に、mainに残った確認用のコメント行を、ファイルごとに2つのプルリクエストで取り除きました。`ansible/site.yml`の行を消した`#13`（マージコミット`ea7a526`）のマージで起動した実行（`#21`）では、`terraform-apply`がスキップされ、`ansible-apply`だけが動きました。

![プルリクエスト#13のマージで起動した実行#21。terraform-applyがスキップされてもansible-applyが動いている](/images/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-05/section6-push-ansible-only.png)

**▼ 実行結果（ansible-applyジョブのステップ「Ansible playbook」から抜粋）**

```plaintext
（途中省略：コマンドの表示、PLAYとTASKの表示、Pythonのインタープリターに関する警告）

PLAY RECAP *********************************************************************
target-node1               : ok=2    changed=0    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0   
target-node2               : ok=2    changed=0    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0   
target-node3               : ok=2    changed=0    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0   
```

`terraform/main.tf`の行を消した`#14`（マージコミット`a235999`）では、`terraform-apply`の後に`ansible-apply`が動きました。

確認の後、手元で終了時点の状態を確認しました。

**実行コマンド**

```plaintext
cd ~/iac/docker-lab-ci/terraform
terraform plan
cd ~/iac/docker-lab-ci/ansible
ansible-playbook -i dynamic_inventory.py site.yml --check
```

**▼ 実行結果**

```plaintext
（途中省略：Refreshing state...によるリソース一覧の出力）

No changes. Your infrastructure matches the configuration.

Terraform has compared your real infrastructure against your configuration and found no differences, so no changes are needed.

（途中省略：PLAYとTASKの表示、Pythonのインタープリターに関する警告）

PLAY RECAP **********************************************************************************************************************************************************************************
target-node1               : ok=2    changed=0    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
target-node2               : ok=2    changed=0    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
target-node3               : ok=2    changed=0    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
```

### ■ 結果

変更されたパスによって、プルリクエストでもmainへのプッシュでも、TerraformとAnsibleのジョブが切り替わり、Terraform→Ansibleの順で動くようになりました。

|変更|プルリクエスト|mainへのプッシュ|
|---|---|---|
|`terraform/`だけ|`terraform-plan`→`ansible-check`|`terraform-apply`→`ansible-apply`|
|`ansible/`だけ|`ansible-check`だけ|`ansible-apply`だけ|
|両方|`terraform-plan`→`ansible-check`|`terraform-apply`→`ansible-apply`|
|ワークフローのファイルだけ|どちらも動かない|どちらも動かない|
|Terraformのジョブが失敗|`ansible-check`は動かない|（同じ条件式で、`ansible-apply`は動かない）|

`needs`で順序を指定するだけでは、順序の前にあるジョブがスキップされたとき、後のジョブも黙ってスキップされ、ワークフローは成功として終わりました。順序の保証には、「前のジョブがスキップされたら動く」「前のジョブが失敗したら動かない」を、条件式で区別する必要があります。

一方で、この構成では、`terraform/`に変更があれば、変更の中身に関係なくAnsibleを動かしています。**[第2回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part1/ansible-gitops-part1-02/)** の「再生成を伴う変更では全タスクを適用し直す」は満たしますが、Ansibleに関係しないTerraformの変更でもAnsibleが動きます。planの結果から、Ansibleの要否や作り直しを読み取る仕組みは、**[第9回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-09/)** で扱います。

---

[↑ 目次に戻る](#-目次)

---

## 7. この回の暫定構成と残る課題

ここまでで、プルリクエストで確認し、マージで適用するパイプラインの骨格ができました。ただし、骨格を先に動かすため、いくつかの部分を暫定のまま残しています。

### 暫定のまま残した部分

|暫定の部分|この回の構成|残る問題|
|---|---|---|
|tfstateの置き場所|ランナーと同じホストの`terraform.tfstate`を、ジョブから`-state`でパスを指定して読み書きする|tfstateがランナーの1台のホストにしかない。`-state`は非推奨の警告が出る。手元の作業とパイプラインが、同じtfstateを同時に触る可能性がある|
|直接プッシュの適用|mainへのプッシュをきっかけに適用する|プルリクエストを通っていないコミットも適用される（**[セクション4](#4-プルリクエストで確認しマージで適用する)**）|
|適用前の承認|プルリクエストでは確認系を実行するだけで、マージすれば適用される|planの内容を見て、適用してよいかを判断する場所がない|
|Ansibleの要否の判定|`terraform/`に変更があれば、常にAnsibleも動かす|Ansibleに関係しないTerraformの変更でもAnsibleが動く。planの中身（作り直しや削除）は見ていない（**[セクション6](#6-terraformからansibleへの実行順序を保証する)**）|
|機密情報|パスワードはGitHubのSecretsから`TF_VAR_`で渡す。接続に使う秘密鍵は、tfstateの出力からジョブの中で書き出し、ジョブの最後に削除する|秘密鍵はtfstateに残っている。パスワードの値が、ログの伏せ字から推測できる（**[セクション5](#5-変更されたパスを判定する)**）|
|既存のワークフロー|`drift-check.yml`と`e2e-provisioning-test.yml`は、ホステッドランナーの中に別のコンテナを作って動かす|パイプラインが管理する操作対象のドリフトは、定期的に検知されていない|

### 残る課題と、扱う回

|課題|扱う回|
|---|---|
|tfstateの置き場所と、連続マージや手動実行による同時実行の制御|**[第6回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-06/)**|
|planのレビューと承認ゲート|**[第7回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-07/)**|
|プルリクエストを通ってmainに入ったコミットかを、適用前に確認する仕組み|**[第7回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-07/)**・**[第8回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-08/)**|
|Ansible側のガードレール（ansible-lint、Molecule）|**[第8回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-08/)**|
|Terraform側のガードレールと、planから作り直しや削除を読み取る仕組み|**[第9回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-09/)**|
|複数環境への分岐|**[第10回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-10/)**|
|ロールバック|**[第11回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-11/)**|
|失敗したパイプラインの診断|**[第12回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-12/)**|
|機密情報の扱い（tfstateやジョブのログを含む）|第3部（**[第13回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part3/ansible-gitops-part3-13/)** 〜 **[第16回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part3/ansible-gitops-part3-16/)**）|
|パイプラインが管理する操作対象の定期的なドリフト検知|第4部（**[第18回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part4/ansible-gitops-part4-18/)** ほか）|

この表は、第2部以降のロードマップでもあります。**[第6回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-06/)** からは、この骨格の上に、ここで挙げた課題を1つずつ積み上げていきます。

---

[↑ 目次に戻る](#-目次)

---

## 8. クラウドプロバイダーへの書き換え点

この回で組んだパイプラインを、AWSやGCPのプロバイダーに切り替える場合に、どこを書き換え、どこが変わらないかを整理します。クラウドでの実行は行っていないため、ここでは書き換える箇所を並べて比べるだけにします。

### 書き換えるファイルと、変わらないファイル

この回で組んだ`gitops-pipeline.yml`のパイプラインで、Dockerプロバイダーに依存しているのは`terraform/`配下だけです。ファイルごとに整理すると、次のようになります。

|ファイル|Docker（本シリーズの検証環境）|AWS|GCP|
|---|---|---|---|
|`terraform/main.tf`のプロバイダーとリソース|`kreuzwerker/docker`の`docker_image`、`docker_container`|`hashicorp/aws`の`aws_instance`など|`hashicorp/google`の`google_compute_instance`など|
|`terraform/`配下の`Dockerfile`|SSHで接続できる状態までをイメージに組み込む|マシンイメージ（AMI）と、起動時の初期設定（ユーザーデータ）に移る|マシンイメージと、起動時の初期設定（起動スクリプト）に移る|
|`terraform/outputs.tf`の`target_nodes`|`docker_container`の`network_data[0].ip_address`|`aws_instance`の`private_ip`|`google_compute_instance`の`network_interface[0].network_ip`|
|`ansible/dynamic_inventory.py`|`terraform output`から読む|そのまま使うか、`amazon.aws.aws_ec2`に置き換える|そのまま使うか、`google.cloud.gcp_compute`に置き換える|
|`.github/workflows/gitops-pipeline.yml`|―|構造は変わらない（クラウドの認証情報の受け渡しが加わる）|構造は変わらない（クラウドの認証情報の受け渡しが加わる）|

秘密鍵を作る`tls_private_key`と、それを出力する`generated_private_key`は、プロバイダーに依存しないため、そのまま使えます。操作対象に公開鍵を配る方法は、AWSでは`aws_key_pair`、GCPではインスタンスのメタデータ（`ssh-keys`）に変わります。

リソースの属性は、**[aws_instance](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/instance)**、**[google_compute_instance](https://registry.terraform.io/providers/hashicorp/google/latest/docs/resources/compute_instance)** で確認できます。

### ワークフローの構造は変わらない

この回でワークフローに書いたのは、次の判定と順序です。

* プルリクエストでは確認系、mainへのプッシュでは適用系を実行する、トリガーの分け方
* `git diff`で変更されたパスを判定し、TerraformとAnsibleのジョブを切り替える条件
* Terraformのジョブが失敗したときはAnsibleのジョブを止め、スキップされたときは実行する、ジョブ間の条件
* `terraform output`から秘密鍵を書き出し、ジョブの終わりに削除する手順

どれも、Dockerプロバイダーに固有の記述を含みません。プロバイダーを切り替えても、パスの判定も、Terraform→Ansibleの順序も、そのまま使えます。

ワークフローに加わるのは、クラウドの認証情報をジョブに渡す部分です。Terraformのジョブは、クラウドのAPIを呼び出すために認証情報が必要になります。

### インベントリの生成は2通りある

クラウドでは、インベントリの生成方法を2通りから選べます。

**1. `dynamic_inventory.py`をそのまま使う**

`outputs.tf`の`target_nodes`を、インスタンスのプライベートIPアドレスを返すように書き換えれば、`dynamic_inventory.py`も、ワークフローの`-i dynamic_inventory.py`も、変えずに使えます。接続先はtfstateから読むため、インベントリに入るのはTerraformが作ったインスタンスだけです。

**2. 動的インベントリプラグインに置き換える**

AWSには`amazon.aws.aws_ec2`、GCPには`google.cloud.gcp_compute`という動的インベントリプラグインがあります。プラグインは、実行のたびにクラウドのAPIに問い合わせて、インスタンスの一覧からインベントリを作ります。設定ファイルの名前には決まりがあり、**[amazon.aws.aws_ec2 inventory – EC2 inventory source](https://docs.ansible.com/projects/ansible/latest/collections/amazon/aws/aws_ec2_inventory.html)** では`aws_ec2.yml`か`aws_ec2.yaml`で終わる名前、**[google.cloud.gcp_compute inventory – Google Cloud Compute Engine inventory source](https://docs.ansible.com/ansible/latest/collections/google/cloud/gcp_compute_inventory.html)** では`gcp_compute.yml`か`gcp.yml`（拡張子は`.yaml`も可）で終わる名前にするよう書かれています。

設定ファイルは、たとえば次のような形になります（クラウドでは実行していません）。

* **ファイル名：`ansible/inventory.aws_ec2.yml`（例）**

```yaml
plugin: amazon.aws.aws_ec2
regions:
  - ap-northeast-1
filters:
  instance-state-name: running
compose:
  ansible_host: private_ip_address
```

* **ファイル名：`ansible/inventory.gcp_compute.yml`（例）**

```yaml
plugin: google.cloud.gcp_compute
projects:
  - example-project
zones:
  - asia-northeast1-a
filters:
  - status = RUNNING
compose:
  ansible_host: networkInterfaces[0].networkIP
```

プラグインを使う場合、構成は次の点で変わります。

* Ansibleのジョブは、tfstateを読む代わりに、クラウドのAPIを読むための認証情報が必要になる
* APIの問い合わせには、Terraformで作っていないインスタンスも含まれるため、タグやラベルで対象を絞る条件を`filters`に書く必要がある
* `dynamic_inventory.py`が付けていたグループ名（`target_nodes`）と接続ユーザー（`ansible_user`）は、プラグインの`keyed_groups`、`groups`、`compose`で作り直す必要がある
* ワークフローの`-i dynamic_inventory.py`を、設定ファイルの名前に書き換える

### 本シリーズでの扱い

本シリーズは、1の`dynamic_inventory.py`をそのまま使う構成を前提にします。**[第2回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part1/ansible-gitops-part1-02/)** で、接続先はTerraformの実行結果としてGitの外にあると整理し、この回もtfstateから接続先を読む構成にしたためです。Terraformが作ったものだけを対象にする、という範囲もtfstateで決まります。

2のプラグインが向いているのは、インスタンスの1台1台がtfstateに記録されない構成です。たとえば、AWSのAuto Scalingグループでは、Terraformが管理するのはグループの定義で、グループが起動したインスタンスはtfstateに個別には記録されません。この場合は、クラウドのAPIからインスタンスの一覧を読むしかありません。

### クラウドで加わる前提

プロバイダーを切り替えると、ワークフローの外で、次の2つが前提に加わります。

* ランナーの置き場所：**[第4回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part1/ansible-gitops-part1-04/)** のセクション7で整理したとおり、Terraformの接続先（クラウドのAPI）とAnsibleの接続先（VPCのプライベートサブネットのインスタンス）は場所が分かれる。self-hostedランナーは、インスタンスと同じVPCの中に置く必要がある
* クラウドの認証情報：Terraformのジョブと、プラグインを使う場合はAnsibleのジョブにも必要になる。`amazon.aws.aws_ec2`のドキュメントには、認証情報を渡さない場合、実行するホストに関連付けたIAMインスタンスプロファイルのロールが使われると書かれている。認証情報をどこに置き、どこまで外部に預けるかは、第3部（**[第13回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part3/ansible-gitops-part3-13/)** 〜 **[第16回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part3/ansible-gitops-part3-16/)**）で扱う

プロバイダーを切り替えて変わるのは、Terraformが作るものと、その接続先をAnsibleに渡す方法です。変更の種類からジョブを判定し、Terraform→Ansibleの順で実行するパイプラインの構造は、プロバイダーを問わず同じです。

次のセクションでは、この回で確認した内容をまとめます。

---

[↑ 目次に戻る](#-目次)

---

## 9. まとめ

この回で整理した内容を確認します。

* プルリクエストでは確認系（`terraform plan`、`ansible-playbook --check`）、mainへのプッシュでは適用系（`terraform apply`、`ansible-playbook`）を実行するワークフローを組み、**[第4回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part1/ansible-gitops-part1-04/)** で導入したself-hostedランナーの上で動くことを実機で確認した
* リポジトリを`terraform/`と`ansible/`に再配置し、ワークフローの各ステップに作業ディレクトリを指定した。既存のドリフト検知とE2Eテストのワークフローが、再配置後も動くことを実機で確認した
* インベントリはGitに置かず、Ansibleのジョブの中で`terraform output`から読む構成にした。Terraformがインベントリや秘密鍵をファイルとして書き出す構成では、チェックアウトしたばかりの作業ディレクトリで、そのファイルが毎回追加のリソースとして`terraform plan`に現れた
* `terraform output`の失敗をスクリプトが握りつぶすと、Ansibleはインベントリを読み込めず、1台にも接続しないまま、パイプラインは成功で終わった。スクリプトが終了コードを返すようにし、`ansible.cfg`に`unparsed_is_failed = True`を設定して、ジョブが失敗するようにした
* ワークフロー単位の`paths`フィルタでは、ワークフローを起動するかどうかしか決められない。ジョブごとの切り替えは、変更されたパスを判定するジョブを置き、その出力を後続のジョブの条件にして実装した
* `needs`で順序をつけると、依存先のジョブがスキップされたときに依存元のジョブまでスキップされ、`ansible/`だけの変更でAnsibleのジョブが動かなかった。`!cancelled()`と`needs.<ジョブ名>.result != 'failure'`を条件に加え、Terraformのジョブが失敗したときだけAnsibleのジョブを止める形にした。両方にまたがる変更では、Terraform→Ansibleの順で実行されることを実機で確認した
* tfstateの置き場所、パスワードと秘密鍵の渡し方、mainへの直接プッシュでも適用が走ることは、暫定のまま残した。それぞれ **[第6回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-06/)**、第3部（**[第13回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part3/ansible-gitops-part3-13/)** 〜 **[第16回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part3/ansible-gitops-part3-16/)**）、**[第7回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-07/)**・**[第8回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-08/)** で扱う
* AWSやGCPに切り替える場合、書き換えるのは`terraform/`配下のプロバイダー、リソース、接続先の出力で、インベントリはスクリプトのまま使うか、動的インベントリプラグインに置き換える。ワークフローの構造は変わらず、インスタンスと同じVPCに置くランナーと、クラウドの認証情報が前提に加わる

---

[↑ 目次に戻る](#-目次)

---

## 10. 次回予告

本シリーズの **[第4回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part1/ansible-gitops-part1-04/)** では、パイプラインを動かす場所として、操作対象と同じネットワーク内に置くself-hostedランナーを採用しました。第5回となる今回は、そのランナーの上で、GitHub ActionsからTerraformとAnsibleを実行する基本の構成を組みました。リポジトリを`terraform/`と`ansible/`に再配置したうえで、実行時のインベントリの生成、プルリクエストで確認しマージで適用する流れ、変更されたパスによるジョブの切り替え、Terraform→Ansibleの実行順序の保証を実装しました。その中で、パイプラインが成功で終わってもAnsibleが1台にも接続していない状態や、依存先のジョブのスキップでAnsibleのジョブまでスキップされる挙動を実機で確認し、それぞれを防ぐ設定と条件を加えました。最後に、AWSやGCPに切り替える場合の書き換え点を整理しました。

今回から、第2部「GitHub Actionsによる自動化パイプライン」に入りました。第2部では、この回で組んだ骨格の上に、tfstateの管理、planの承認、AnsibleとTerraformの両側のガードレール、環境の分岐、ロールバック、失敗時の診断を、**[第12回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-12/)** まで順に積み上げていきます。この回で暫定のまま残した部分は、その中で1つずつ置き換えていきます。

**[第6回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-06/)** では、この回で暫定のままにしたtfstateの置き場所を扱います。今回のパイプラインは、ジョブがチェックアウトする作業ディレクトリとは別の場所にある、ランナーホスト上のtfstateを指定して読み書きする構成で、ジョブの作業ディレクトリにはtfstateがありません。**[第6回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-06/)** では、self-hostedランナー上でtfstateが消える問題と置き場所の設計に加え、連続したマージや手動実行で、複数のパイプラインが同時に動く場合を扱います。Terraformのstateロックとパイプラインの直列化による二重の保護を設計し、Ansibleにはロックがないという非対称性を示します。

**[次回：第6回：tfstateの管理とパイプラインの同時実行](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-06/)**

---

📑 連載の移動　**[前の記事：【GitOps編】第4回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part1/ansible-gitops-part1-04/)　｜　[次の記事：【GitOps編】第6回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-06/)**

---

> **🗺️ 初めての方、シリーズの全体像を知りたい方はこちら**
>
> シリーズ全体については、以下のまとめブログで整理しています。
>
> → **「Ansible×TerraformをGitOpsで回す」〜Terraformプロバイダーを問わない構成管理の自動化〜 第2部まとめブログ：GitOpsパイプラインで「見たものだけが、承認したときだけ届く」仕組みを積み上げる** **※近日公開予定**

---

[↑ 目次に戻る](#-目次)

---

## 11. 連載一覧：「Ansible×TerraformをGitOpsで回す」

### 第1部：GitOpsの基本概念とAnsibleとの接続

|回数|テーマ、記事タイトル|概要|
|---|---|---|
|**[第1回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part1/ansible-gitops-part1-01/)**|なぜ「Gitがインフラの唯一の真実」なのか|GitOpsの4原則を評価軸として、AnsibleとTerraformの充足度を整理する。push型構成の立ち位置と、「唯一の真実」が崩れる3つの経路を示す。|
|**[第2回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part1/ansible-gitops-part1-02/)**|AnsibleとTerraformのGitOps上での責務分担|責務分担を「変更の種類ごとに必要な実行」として捉え直す。変更の3分類、境界が曖昧な設定の判定基準、Gitの外にある接続面を整理する。|
|**[第3回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part1/ansible-gitops-part1-03/)**|GitリポジトリとAnsibleの構造設計|変更の分類をパスで表現するディレクトリ構成、Gitに置くもの・置かないもの、モノレポとマルチリポの選択基準、mainを唯一の真実とするブランチ運用を設計する。無料プランの非公開リポジトリでは直接プッシュを防げないため、強制する場所を適用前に移す方針を示す。|
|**[第4回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part1/ansible-gitops-part1-04/)**|ローカルGitea vs GitHub Actionsの選択基準|到達性・状態の永続性・機密情報の置き場所・運用負荷の4基準で比較し、選択が信頼境界の要件で決まることを示す。本シリーズはGitHub＋self-hostedランナーを採用し、リポジトリを非公開で運用する。第1部の最終回。|

### 第2部：GitHub Actionsによる自動化パイプライン

|回数|テーマ、記事タイトル|概要|
|---|---|---|
|**[第5回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-05/)**|GitHub ActionsからAnsibleを実行する基本構成|プルリクエストで確認、マージで適用という基本フローを実装する。変更されたパスによるジョブの切り替え、Terraform→Ansibleの実行順序の保証、実行時のインベントリの生成を扱い、AWS・GCPプロバイダーへの書き換え点を示す。第2部の初回。|
|**[第6回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-06/)**|tfstateの管理とパイプラインの同時実行|self-hostedランナー上でtfstateが消える問題と置き場所の設計、連続マージや手動実行との同時実行を扱う。Terraformのstateロックとパイプラインの直列化による二重の保護を設計し、Ansibleにはロックがないという非対称性を示す。|
|**[第7回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-07/)**|planのレビューと承認ゲート|レビューしたplanと実際に適用される内容のずれ、保存したplanの適用、`--check --diff`で承認者に見えない変更を扱う。無料プランの非公開リポジトリでも動く、手動起動による承認ゲートを設計する。「プッシュのたびにインフラが変わる恐怖」への回答となる回。|
|**[第8回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-08/)**|GitOpsの品質ガードレールとしてMoleculeとansible-lintを組み込む|Moleculeシリーズ第4回の「確認し続ける仕組み」の次の段階として、確認結果を「インフラに届くための条件」にする。適用前にチェック結果を確認する構成と、`changed_when: false`によるすり抜けという限界を示す。|
|**[第9回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-09/)**|Terraform側にもガードレールを置く|コードに対する静的チェックと、planに対するポリシーチェックの2層を整理する。planから再生成・削除を検知し、Ansibleの設定消失を適用前に扱う3ツール統合ならではのガードレールを作る。|
|**[第10回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-10/)**|複数環境（dev/stg/prod）へのデプロイを分岐させる|環境をブランチではなく、mainの1本と環境別ディレクトリで分ける。tfstate・インベントリ・承認を環境ごとに分け、昇格の順序と条件をワークフローで強制する。「最後に適用したコミット」の記録を導入する。|
|**[第11回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-11/)**|git revertしてもOSは戻らない：ロールバックの非対称性|宣言型のTerraformはrevertで戻るが、手続き型のAnsibleは入れた設定が残るという非対称性を実機で示す。GitOpsのロールバックをロールフォワードとして整理し、revertの残骸が検知できないことを示す。|
|**[第12回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-12/)**|失敗したパイプラインをどう診断するか|パイプラインの失敗をGitHub Actions・ガードレール・Terraform・Ansibleの4層に分け、「設計どおりの停止か、故障か」を切り分ける。Ansible×Terraformシリーズ第3部の知識を活用する。第2部の最終回。|

---

[↑ 目次に戻る](#-目次)

---