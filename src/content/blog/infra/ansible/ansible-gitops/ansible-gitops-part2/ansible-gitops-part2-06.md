---
title: '「Ansible×TerraformをGitOpsで回す」〜Terraformプロバイダーを問わない構成管理の自動化〜 第6回：tfstateの管理とパイプラインの同時実行'
description: 'self-hostedランナーで動くパイプラインで、tfstateをどこに置き、複数の実行が重なったときに何がtfstateと操作対象を守るのかを扱う。作業ディレクトリに置いたtfstateの扱いを確認したうえで、置き場所を「消えないか」「ロックが効くか」「共有できるか」で選び、リモートバックエンドに移行する。同時実行は、パイプラインの直列化とTerraformのstateロックの二重で防ぐ設計とし、Ansibleにはロックがないという非対称性を示す。'
pubDate: 2026-10-07
category: 'infra'
tags: ['Ansible', 'Terraform', 'GitOps', 'GitHub Actions', 'tfstate']
seriesId: 'ansible-gitops-part2'
seriesNo: 6
prevPost: 'https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-05/'
nextPost: 'https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-07/'
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
2. [作業ディレクトリに置いたtfstateが消える](#2-作業ディレクトリに置いたtfstateが消える)
3. [tfstateの置き場所を選ぶ](#3-tfstateの置き場所を選ぶ)
4. [同時実行はどこで起きるのか](#4-同時実行はどこで起きるのか)
5. [パイプライン層とツール層の二重の保護](#5-パイプライン層とツール層の二重の保護)
6. [クラウドプロバイダーでも設計は変わらない](#6-クラウドプロバイダーでも設計は変わらない)
7. [まとめ](#7-まとめ)
8. [次回予告](#8-次回予告)
9. [連載一覧：「Ansible×TerraformをGitOpsで回す」](#9-連載一覧ansibleterraformをgitopsで回す)

---

## 1. はじめに

AnsibleとTerraformのパイプラインを、GitHub Actionsのself-hostedランナーで動かしていて、

* tfstateは、Terraformが自動で作り、更新してくれる
* `terraform apply`を、手元での実行から、self-hostedランナーのパイプラインでの実行に切り替えた
* 実行する場所が変わっても、tfstateの扱いは変わらない

と考えていないでしょうか。

tfstateを扱う記事の多くは、リモートバックエンドの設定方法を中心にしています。一方、self-hostedランナーの作業ディレクトリでtfstateがどう扱われるかや、Ansibleを含めたパイプライン全体の同時実行は、あまり扱われていません。AnsibleとTerraformのパイプラインを自動で動かし始めると、次のような場面にぶつかります。

* 2回目の実行で、Terraformが既存のリソースをすべて新規に作成しようとする
* パイプラインが`Error acquiring the state lock`で止まる
* 手元で`terraform apply`を実行している最中に、マージをきっかけにパイプラインが動き出す
* 同じホストに対して、2本の`ansible-playbook`が同時に流れる

これらは、tfstateの置き場所の問題や、実行のタイミングの問題に見えます。共通しているのは、tfstateをどこに置き、複数の実行が重なったときに何がそれを止めるのかが、パイプラインの構造として決まっていない点です。

パイプラインでのtfstateの扱いは、「AnsibleとTerraformの連携が壊れる理由はライフサイクルにあった」（以下、Ansible×Terraformシリーズ）でも扱ってきました。Ansible×Terraformシリーズの **[第37回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part4/ansible-terraform-part4-37/)** では、GitHub Actionsのワークフローで、定期的なドリフトの検知と自動収束を実行しました。ホステッドランナーは実行のたびに使い捨てられるため、このワークフローは、コンテナの起動から検知までを1回の実行の中で完結させる構成です。tfstateも実行のたびにランナーの中で作られ、実行が終わるとランナーとともになくなります。そのため、tfstateを実行と実行の間でどこに残すかは、問題になりませんでした。

本シリーズの **[第1回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part1/ansible-gitops-part1-01/)** のセクション3では、Terraformが差分の計算に使うtfstateは、HCLと違ってGitの外にあると整理し、その置き場所を第2部で扱うとしました。同じ **[第1回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part1/ansible-gitops-part1-01/)** のセクション6では、Gitを経由しない手動変更を、「唯一の真実」が崩れる経路の1つとして整理しました。パイプラインの外で、手元から実行する`terraform apply`や`ansible-playbook`も、この経路の1つになり得ます。**[第2回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part1/ansible-gitops-part1-02/)** のセクション4では、AnsibleとTerraformの接続面であるIPアドレスはtfstateにしかなく、Gitで管理するのはその生成手順であることを確認しました。tfstateがなくなれば、Ansibleは接続先を読み出せなくなります。**[第4回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part1/ansible-gitops-part1-04/)** では、操作対象が実行をまたいで存在し続けるself-hostedランナーを、第2部以降の実行基盤に固定しました。操作対象が実行をまたいで残る以上、その状態を記録したtfstateも、実行をまたいで残す必要があります。

**[第5回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-05/)** では、プルリクエストで確認し、マージで適用するパイプラインの骨格を組みました。tfstateは、ジョブのチェックアウト先ではなく、ランナーと同じホストにある手元の作業ディレクトリのtfstateを、`-state`でパスを指定して読み書きする暫定の構成にしました。同じ **[第5回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-05/)** のセクション7では、この構成に次の3つの問題が残ると整理しました。

* tfstateが、ランナーの1台のホストにしかない
* `-state`は、非推奨の警告が出る
* 手元の作業とパイプラインが、同じtfstateを同時に触る可能性がある

第6回となる今回は、**[第5回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-05/)** で暫定のまま残したtfstateの扱いを、置き場所と同時実行の2つの問題として設計します。まず、ランナーの作業ディレクトリに置いたtfstateが、次の実行でどう扱われるかを確認します。そのうえで、tfstateの置き場所を「消えないか」「ロックが効くか」「ランナーを増やしても共有できるか」の3つの基準で比較し、ローカルで起動できる、ロックに対応したリモートバックエンドに移行します。同時実行については、起きる経路を整理し、パイプラインの直列化とTerraformのstateロックによる二重の保護を設計します。あわせて、Ansibleにはstateロックに相当する仕組みがないという非対称性を示します。

正確に言うと、**tfstateの管理と同時実行の制御は、Terraformだけの問題ではなく、Ansibleを含めたパイプライン全体の設計の問題です**。この回で扱う問いは、「tfstateをどこに置けば消えず、複数の実行が重なったときに、何がtfstateと操作対象を守るのか」です。

次のセクションでは、ランナーの作業ディレクトリに置いたtfstateが、次の実行でどう扱われるかを確認します。

---

[↑ 目次に戻る](#-目次)

---

## 2. 作業ディレクトリに置いたtfstateが消える

self-hostedランナーの作業ディレクトリに置いたtfstateが、次の実行でどう扱われるかを実機で確認します。

### チェックアウトは、Git管理外のファイルを掃除する

**[第5回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-05/)** のセクション3で確認したとおり、ジョブは、ランナーの作業フォルダの下にリポジトリをチェックアウトして動きます。self-hostedランナーでは、ジョブが終わっても作業フォルダが残ります。そのため、tfstateをチェックアウト先の`terraform/`に置けば、次の実行でもそのまま使えるように見えます。

一方、`actions/checkout`のREADME（**[actions/checkout](https://github.com/actions/checkout)**）では、入力の`clean`は、取得の前に`git clean -ffdx`と`git reset --hard HEAD`を実行するかを指定するもので、既定値は`true`とされています。`git clean`の`-x`は、`.gitignore`などの除外の規則を使わずに、Gitで管理していないファイルをすべて削除の対象にするオプションです（**[git-clean](https://git-scm.com/docs/git-clean)**）。**[第3回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part1/ansible-gitops-part1-03/)** で`.gitignore`の対象にしたtfstateも、この掃除の対象に含まれることになります。

### ■ 検証内容：作業ディレクトリに置いたtfstateの、次の実行での扱い

確認用のワークフローを作業用のブランチに追加し、2回実行します。1回目の実行で、手元のtfstateのコピーをチェックアウト先の`terraform/`に置き、2回目の実行で、そのコピーがどうなるかを見ます。手元のtfstateそのものには触れず、`terraform apply`も実行しません。

まず、手元のtfstateと、ランナーの作業ディレクトリの状態を確認します。

**実行コマンド**

```plaintext
cd ~/iac/docker-lab-ci
ls -l --time-style=full-iso terraform/terraform.tfstate
ls -la ~/actions-runner/_work/ansible-terraform-ci-lab/ansible-terraform-ci-lab/terraform/
```

**▼ 実行結果**

```plaintext
-rw-rw-r-- 1 control control 28767 2026-10-07 01:05:48.088773967 +0000 terraform/terraform.tfstate
total 44
drwxr-xr-x 3 control control 4096 Oct  6 02:50 .
drwxr-xr-x 7 control control 4096 Oct  5 09:00 ..
-rw-r--r-- 1 control control  778 Oct  5 09:00 Dockerfile
-rw-r--r-- 1 control control  567 Oct  5 09:00 Dockerfile.deploy_nopasswd
-rw-r--r-- 1 control control  567 Oct  5 09:00 Dockerfile.deploy_passwd
-rw-r--r-- 1 control control  769 Oct  5 09:00 Dockerfile.legacy
-rw-r--r-- 1 control control  107 Oct  5 09:00 id_ed25519.pub
-rw-r--r-- 1 control control 3720 Oct  6 02:47 main.tf
-rw-r--r-- 1 control control  497 Oct  5 09:00 outputs.tf
drwxr-xr-x 3 control control 4096 Oct  6 02:50 .terraform
-rw-r--r-- 1 control control 2485 Oct  5 11:28 .terraform.lock.hcl
```

ランナーの作業ディレクトリの`terraform/`には、`.tf`ファイルと、前のジョブの`terraform init`で作られた`.terraform/`があり、tfstateはありません。

確認用のワークフローは、次のとおりです。

* **ファイル名：`.github/workflows/state-cleanup-check.yml`**

```yaml
name: State Cleanup Check

on:
  push:
    branches:
      - gitops06-state-cleanup

env:
  TF_VAR_ansible_user_password: ${{ secrets.TF_VAR_ANSIBLE_USER_PASSWORD }}
  TF_VAR_deploy_user_password: ${{ secrets.TF_VAR_DEPLOY_USER_PASSWORD }}

jobs:
  state-cleanup:
    runs-on: [self-hosted, Linux, X64]
    steps:
      - name: Show tfstate before checkout
        run: |
          pwd
          ls -l terraform/terraform.tfstate && rc=0 || rc=$?
          echo "exit_code=${rc}"
      - uses: actions/checkout@v4
      - name: Show tfstate after checkout
        run: |
          ls -l terraform/terraform.tfstate && rc=0 || rc=$?
          echo "exit_code=${rc}"
      - name: Place tfstate in workspace
        working-directory: terraform
        run: |
          umask 077
          cp /home/control/iac/docker-lab-ci/terraform/terraform.tfstate terraform.tfstate
          ls -l terraform.tfstate
      - name: Terraform init
        working-directory: terraform
        run: terraform init -input=false -lockfile=readonly
      - name: Terraform plan
        working-directory: terraform
        run: terraform plan -input=false
```

チェックアウトの前と後に、作業ディレクトリの`terraform/terraform.tfstate`の有無を表示します。`ls`が失敗するとステップがそこで止まるため、終了コードを受け取って表示しています。「Place tfstate in workspace」では、手元のtfstateのコピーを`terraform/`に置きます。`terraform plan`には`-state`を付けず、作業ディレクトリのtfstateを読ませます。このワークフローは作業用のブランチへのプッシュでしか起動しないため、`gitops-pipeline.yml`は動きません。

このワークフローを作業用のブランチにコミットしてプッシュし、1回目の実行を起動しました。

**▼ 実行結果（1回目、ステップ「Show tfstate before checkout」）**

```plaintext
Run pwd
（途中省略：実行したスクリプト、シェル、環境変数の表示）
/home/control/actions-runner/_work/***-terraform-ci-lab/***-terraform-ci-lab
exit_code=2
ls: cannot access 'terraform/terraform.tfstate': No such file or directory
```

パスの中の`***`は、`ansible`です。**[第5回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-05/)** のセクション5で確認したとおり、この検証環境では、Secretsの値と一致する`ansible`という語が、ログの中で伏せられます。

**▼ 実行結果（1回目、ステップ「Show tfstate after checkout」）**

```plaintext
Run ls -l terraform/terraform.tfstate && rc=0 || rc=$?
（途中省略：実行したスクリプト、シェル、環境変数の表示）
ls: cannot access 'terraform/terraform.tfstate': No such file or directory
exit_code=2
```

**▼ 実行結果（1回目、ステップ「Place tfstate in workspace」）**

```plaintext
Run umask 077
（途中省略：実行したスクリプト、シェル、環境変数の表示）
-rw------- 1 control control 28767 Oct  7 02:12 terraform.tfstate
```

**▼ 実行結果（1回目、ステップ「Terraform init」）**

```plaintext
Run terraform init -input=false -lockfile=readonly
（途中省略：実行したスクリプト、シェル、環境変数の表示）
Initializing provider plugins found in the configuration...
- Reusing previous version of hashicorp/tls from the dependency lock file
- Reusing previous version of kreuzwerker/docker from the dependency lock file
- Using hashicorp/tls v4.3.0 from the shared cache directory
- Using kreuzwerker/docker v3.0.2 from the shared cache directory

Initializing the backend...

Initializing provider plugins found in the state...
- Reusing previous version of hashicorp/tls
- Reusing previous version of kreuzwerker/docker
- Using previously-installed hashicorp/tls v4.3.0
- Using previously-installed kreuzwerker/docker v3.0.2


Terraform has been successfully initialized!

（途中省略：初期化の後の案内）
```

**▼ 実行結果（1回目、ステップ「Terraform plan」）**

```plaintext
Run terraform plan -input=false
（途中省略：実行したスクリプト、シェル、環境変数の表示、Refreshing state...によるリソース一覧の出力）

No changes. Your infrastructure matches the configuration.

Terraform has compared your real infrastructure against your configuration
and found no differences, so no changes are needed.
```

作業ディレクトリに置いたtfstateを読み、`terraform init`は「Initializing provider plugins found in the state...」を表示しました。`terraform plan`は「No changes」で、既存のリソースを認識しています。

ジョブが終わった後の作業ディレクトリを、ホストで確認します。

**実行コマンド**

```plaintext
ls -l ~/actions-runner/_work/ansible-terraform-ci-lab/ansible-terraform-ci-lab/terraform/terraform.tfstate
cd ~/actions-runner/_work/ansible-terraform-ci-lab/ansible-terraform-ci-lab
git status --ignored --short --untracked-files=all
```

**▼ 実行結果**

```plaintext
-rw------- 1 control control 28767 Oct  7 02:12 /home/control/actions-runner/_work/ansible-terraform-ci-lab/ansible-terraform-ci-lab/terraform/terraform.tfstate
!! terraform/.terraform/providers/registry.terraform.io/hashicorp/tls/4.3.0/linux_amd64
!! terraform/.terraform/providers/registry.terraform.io/kreuzwerker/docker/3.0.2/linux_amd64
!! terraform/terraform.tfstate
```

ジョブが終わっても、作業ディレクトリに置いたtfstateは残っていました。Gitからは、`.gitignore`の除外対象（`!!`）として見えています。

次に、tfstateのコピーを置くステップをワークフローから外し、2回目の実行を起動します。

**実行コマンド**

```plaintext
cd ~/iac/docker-lab-ci
sed -i '/- name: Place tfstate in workspace/,/^          ls -l terraform\.tfstate$/d' .github/workflows/state-cleanup-check.yml
git --no-pager diff
```

**▼ 実行結果**

```plaintext
diff --git a/.github/workflows/state-cleanup-check.yml b/.github/workflows/state-cleanup-check.yml
index 74db82d..2620984 100644
--- a/.github/workflows/state-cleanup-check.yml
+++ b/.github/workflows/state-cleanup-check.yml
@@ -23,12 +23,6 @@ jobs:
         run: |
           ls -l terraform/terraform.tfstate && rc=0 || rc=$?
           echo "exit_code=${rc}"
-      - name: Place tfstate in workspace
-        working-directory: terraform
-        run: |
-          umask 077
-          cp /home/control/iac/docker-lab-ci/terraform/terraform.tfstate terraform.tfstate
-          ls -l terraform.tfstate
       - name: Terraform init
         working-directory: terraform
         run: terraform init -input=false -lockfile=readonly
```

この変更をコミットしてプッシュし、2回目の実行を起動しました。

**▼ 実行結果（2回目、ステップ「Show tfstate before checkout」）**

```plaintext
Run pwd
（途中省略：実行したスクリプト、シェル、環境変数の表示）
/home/control/actions-runner/_work/***-terraform-ci-lab/***-terraform-ci-lab
-rw------- 1 control control 28767 Oct  7 02:12 terraform/terraform.tfstate
exit_code=0
```

**▼ 実行結果（2回目、ステップ「Show tfstate after checkout」）**

```plaintext
Run ls -l terraform/terraform.tfstate && rc=0 || rc=$?
（途中省略：実行したスクリプト、シェル、環境変数の表示）
ls: cannot access 'terraform/terraform.tfstate': No such file or directory
exit_code=2
```

**▼ 実行結果（2回目、ステップ「Terraform init」）**

```plaintext
Run terraform init -input=false -lockfile=readonly
Initializing provider plugins found in the configuration...
- Reusing previous version of kreuzwerker/docker from the dependency lock file
- Reusing previous version of hashicorp/tls from the dependency lock file
- Using kreuzwerker/docker v3.0.2 from the shared cache directory
- Using hashicorp/tls v4.3.0 from the shared cache directory

Initializing the backend...



Terraform has been successfully initialized!

（途中省略：初期化の後の案内）
```

**▼ 実行結果（2回目、ステップ「Terraform plan」）**

```plaintext
Run terraform plan -input=false
（途中省略：実行したスクリプト、シェル、環境変数の表示）

Terraform used the selected providers to generate the following execution
plan. Resource actions are indicated with the following symbols:
  + create

Terraform will perform the following actions:

  # docker_container.targets["target-node1"] will be created
  + resource "docker_container" "targets" {
（途中省略：属性とブロックの一覧）
    }

（途中省略：docker_container.targets["target-node2"]と["target-node3"]の作成計画）

  # docker_image.***_target will be created
（途中省略：内容の表示）

（途中省略：残る3つのdocker_imageの作成計画）

  # docker_network.app_net will be created
（途中省略：内容の表示）

  # docker_network.lab_net will be created
（途中省略：内容の表示）

  # tls_private_key.generated will be created
  + resource "tls_private_key" "generated" {
      + algorithm                     = "ED25519"
      + ecdsa_curve                   = "P224"
      + id                            = (known after apply)
      + private_key_openssh           = (sensitive value)
      + private_key_pem               = (sensitive value)
      + private_key_pem_pkcs8         = (sensitive value)
      + public_key_fingerprint_md5    = (known after apply)
      + public_key_fingerprint_sha256 = (known after apply)
      + public_key_openssh            = (known after apply)
      + public_key_pem                = (known after apply)
      + rsa_bits                      = 2048
    }

Plan: 10 to add, 0 to change, 0 to destroy.

（途中省略：Changes to Outputs、区切り線と-outオプションに関する注意書き）
```

最後に、手元のtfstateが変わっていないこと、作業ディレクトリにtfstateが残っていないことを確認します。

**実行コマンド**

```plaintext
ls -l --time-style=full-iso ~/iac/docker-lab-ci/terraform/terraform.tfstate
ls -l ~/actions-runner/_work/ansible-terraform-ci-lab/ansible-terraform-ci-lab/terraform/terraform.tfstate; echo "exit_code=$?"
```

**▼ 実行結果**

```plaintext
-rw-rw-r-- 1 control control 28767 2026-10-07 01:05:48.088773967 +0000 /home/control/iac/docker-lab-ci/terraform/terraform.tfstate
ls: cannot access '/home/control/actions-runner/_work/ansible-terraform-ci-lab/ansible-terraform-ci-lab/terraform/terraform.tfstate': No such file or directory
exit_code=2
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

### ■ 結果

2回の実行での、作業ディレクトリの`terraform/terraform.tfstate`の有無を並べると、次のとおりです。

|時点|tfstateの有無|
|---|---|
|1回目の実行、チェックアウトの前|なし（`exit_code=2`）|
|1回目の実行、チェックアウトの後|なし（`exit_code=2`）。この後、コピーを置いた|
|1回目の実行の後（ホストで確認）|あり（`.gitignore`の除外対象`!!`）|
|2回目の実行、チェックアウトの前|あり（`exit_code=0`）|
|2回目の実行、チェックアウトの後|なし（`exit_code=2`）|

作業ディレクトリに置いたtfstateは、ジョブが終わった後も、次の実行のチェックアウトまでは残っていました。しかし、次の実行のチェックアウトで削除され、その後のどのステップからも使えませんでした。`.gitignore`で除外していても、`clean`の`git clean -ffdx`の対象になるためです。self-hostedランナーで作業フォルダが残ることは、作業ディレクトリに置いたtfstateが次の実行まで残ることを意味しません。

tfstateがなくなった2回目の実行では、`terraform plan`に「Refreshing state...」の行が1つもありません。Terraformは、既存のリソースを1つも把握しておらず、確認もしていません。そのうえで、コンテナ3台、イメージ4つ、ネットワーク2つ、`tls_private_key.generated`の10個のリソースを、すべて新規作成として計画しました（`Plan: 10 to add, 0 to change, 0 to destroy.`）。

この計画には、次の2つが含まれています。

* 稼働しているコンテナと同じ名前（`target-node1`〜`target-node3`）のコンテナを、新しく作成する計画
* Ansibleの接続に使う鍵を作る`tls_private_key.generated`を、新しく作成する計画

**[第2回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part1/ansible-gitops-part1-02/)** のセクション4で確認したとおり、AnsibleとTerraformの接続面の値は、tfstateにしかありません。**[第5回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-05/)** で組んだパイプラインでは、Ansibleの接続先と鍵も、tfstateの出力から用意しています。tfstateが消えると、Terraformが既存のリソースを見失うだけでなく、Ansibleの接続に使う値の出どころも失われます。

**[第5回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-05/)** でtfstateをチェックアウト先に置かず、作業ディレクトリの外にあるtfstateを`-state`で指定したのは、この掃除の対象から外すためでもあります。`clean`を`false`にすれば、仕様上は掃除そのものを止められます。ただし、その場合も、tfstateはそのランナーの作業フォルダの中にしかなく、**[第5回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-05/)** のセクション7で整理した、ホスト1台への依存と、手元の作業との同時アクセスの問題は残ります。

次のセクションでは、tfstateをどこに置けばよいかを、3つの基準で比較して決めます。

---

[↑ 目次に戻る](#-目次)

---

## 3. tfstateの置き場所を選ぶ

tfstateの置き場所を3つの基準で比較し、ロックに対応したリモートバックエンドに移行します。

### 3つの置き場所と3つの基準

self-hostedランナーのパイプラインで、tfstateの置き場所の候補は次の3つです。

* ランナーの作業ディレクトリ（**[セクション2](#2-作業ディレクトリに置いたtfstateが消える)** で確認した置き方）
* ランナーと同じホストの、作業ディレクトリの外（**[第5回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-05/)** の`-state`による置き方）
* リモートバックエンド

Terraformの公式ドキュメント（**[local](https://developer.hashicorp.com/terraform/language/backend/local)**）では、ローカルバックエンドは、tfstateをローカルのファイルシステムに置き、OSの仕組みでロックするとされています。同じページでは、`-state`は以前の使い方との互換のために残している機能で、新しい仕組みでは使わず、リモートの置き場所に対応したバックエンドを設定するよう案内されています。**[第5回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-05/)** で出ていた非推奨の警告は、この案内に対応するものです。

3つの置き場所を、「消えないか」「ロックが効くか」「ランナーを増やしても共有できるか」の3つの基準で並べると、次のとおりです。

|置き場所|消えないか|ロックが効くか|ランナーを増やしても共有できるか|
|---|---|---|---|
|ランナーの作業ディレクトリ|次の実行のチェックアウトで消える（**[セクション2](#2-作業ディレクトリに置いたtfstateが消える)**）|ファイルが消えるため、実行をまたいだ保護にならない|できない|
|ホストの、作業ディレクトリの外|消えない|効く。ただし、ロックはそのファイルにかかるため、同じファイルを読む実行同士にしか効かない|できない。tfstateはそのホストにしかない|
|リモートバックエンド|消えない|バックエンドがロックに対応していれば効く|できる。バックエンドに届くランナーなら、どこからでも同じtfstateを読み書きできる|

作業ディレクトリの外に置けば、「消えないか」と「ロックが効くか」は、ローカルでも満たせます。差が出るのは、3つ目の基準です。ローカルのtfstateは、そのホストのランナーと、そのホストで手元から実行する`terraform`からしか読めません。ランナーを別のホストに増やすと、そのランナーからは同じtfstateに届かず、ロックも共有されません。

本シリーズは、ロックに対応したリモートバックエンドに移行します。検証環境では、PostgreSQLにtfstateを置くpgバックエンドを使います。公式ドキュメント（**[pg](https://developer.hashicorp.com/terraform/language/backend/pg)**）では、pgバックエンドはstateロックに対応し、PostgreSQLのadvisory lockでロックするとされています。PostgreSQLはDockerのコンテナとして起動できるため、操作対象と同じホストの上で、外部のサービスを使わずに再現できます。

接続情報は、`main.tf`には書かず、環境変数`PG_CONN_STR`で渡します。同じドキュメントでは、接続情報を設定ファイルや`-backend-config`に書くと、`.terraform/`のディレクトリと保存したplanにも値が残るため、環境変数で渡すよう推奨されています。パイプラインには、**[第5回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-05/)** のパスワードと同じく、GitHubのSecretsから渡します。この渡し方は暫定のもので、機密情報の扱いは第3部（**[第13回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part3/ansible-gitops-part3-13/)** 〜 **[第16回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part3/ansible-gitops-part3-16/)**）で扱います。

### ■ 検証内容：pgバックエンドの用意

この検証環境のTerraformのバージョンを確認しておきます。

**実行コマンド**

```plaintext
terraform version
```

**▼ 実行結果**

```plaintext
Terraform v1.15.7
on linux_amd64

（途中省略：新しいバージョンの案内）
```

PostgreSQLのコンテナに渡す初期設定と、Terraformに渡す接続情報を、リポジトリの外のファイルに書きます。パスワードは生成した値をシェルの変数にだけ置き、画面には表示しません。

**実行コマンド**

```plaintext
mkdir -p -m 700 ~/.config/tfstate-backend
install -m 600 /dev/null ~/.config/tfstate-backend/postgres.env
install -m 600 /dev/null ~/.config/tfstate-backend/backend.env
PG_PASSWORD=$(openssl rand -hex 24)
printf 'POSTGRES_USER=terraform\nPOSTGRES_PASSWORD=%s\nPOSTGRES_DB=terraform_backend\n' "$PG_PASSWORD" > ~/.config/tfstate-backend/postgres.env
printf 'PG_CONN_STR=postgres://terraform:%s@127.0.0.1:5432/terraform_backend?sslmode=disable\n' "$PG_PASSWORD" > ~/.config/tfstate-backend/backend.env
unset PG_PASSWORD
ls -la ~/.config/tfstate-backend
```

**▼ 実行結果**

```plaintext
total 16
drwx------ 2 control control 4096 Oct  7 04:40 .
drwxrwxr-x 3 control control 4096 Oct  7 04:40 ..
-rw------- 1 control control  131 Oct  7 04:40 backend.env
-rw------- 1 control control  121 Oct  7 04:40 postgres.env
```

`postgres.env`はコンテナに渡す初期設定で、`POSTGRES_DB`により、pgバックエンドが必要とするデータベース（`terraform_backend`）が起動時に作られます。`backend.env`は、Terraformに渡す接続情報です。このコンテナではTLSを設定していないため、`sslmode=disable`を付け、待ち受けを`127.0.0.1`に限っています。

コンテナを起動します。

**実行コマンド**

```plaintext
docker volume create tfstate-pg-data
```

**▼ 実行結果**

```plaintext
tfstate-pg-data
```

**実行コマンド**

```plaintext
docker run -d --name tfstate-pg \
  --restart unless-stopped \
  --env-file ~/.config/tfstate-backend/postgres.env \
  -p 127.0.0.1:5432:5432 \
  -v tfstate-pg-data:/var/lib/postgresql/data \
  postgres:17
sleep 10
docker ps --filter name=tfstate-pg --format '{{.Names}}\t{{.Status}}\t{{.Ports}}'
docker inspect --format '{{.HostConfig.RestartPolicy.Name}}' tfstate-pg
docker exec tfstate-pg pg_isready -U terraform -d terraform_backend
```

**▼ 実行結果**

```plaintext
（途中省略：イメージのダウンロードの表示）
1a16113f1458356bd6ade9da2bf47e04939dbd9ba065e7c06175750b323aa776
tfstate-pg      Up 10 seconds   127.0.0.1:5432->5432/tcp
unless-stopped
/var/run/postgresql:5432 - accepting connections
```

このコンテナは、Terraformの管理には入れていません。Terraformが`terraform init`の時点で接続する先なので、Terraform自身で作ることはできないためです。操作対象のコンテナは`restart = "no"`ですが、このコンテナは`--restart unless-stopped`にし、ホストを再起動した後も自動で起動するようにしています。

最後に、`backend.env`の値を、GitHubのリポジトリの「Settings」→「Secrets and variables」→「Actions」の「Repository secrets」に、`PG_CONN_STR`という名前で登録しました。

### ■ 検証内容：既存のtfstateの移行

作業用のブランチを作り、移行の前のベースラインを確認します。

**実行コマンド**

```plaintext
cd ~/iac/docker-lab-ci
git switch -c gitops06-remote-backend
cd terraform
terraform plan
```

**▼ 実行結果**

```plaintext
Switched to a new branch 'gitops06-remote-backend'
（途中省略：Refreshing state...によるリソース一覧の出力）

No changes. Your infrastructure matches the configuration.

Terraform has compared your real infrastructure against your configuration and found no differences, so no changes are needed.
```

`main.tf`の`terraform`ブロックに、`backend "pg" {}`を加えます。接続情報は書きません。

**実行コマンド**

```plaintext
sed -i 's/^terraform {$/terraform {\n  backend "pg" {}\n/' main.tf
git --no-pager diff
```

**▼ 実行結果**

```plaintext
diff --git a/terraform/main.tf b/terraform/main.tf
index 188e49f..4b059ba 100644
--- a/terraform/main.tf
+++ b/terraform/main.tf
@@ -1,4 +1,6 @@
 terraform {
+  backend "pg" {}
+
   required_providers {
     docker = {
       source  = "kreuzwerker/docker"
```

接続情報を環境変数に読み込み、`terraform init -migrate-state`で、既存のtfstateをpgバックエンドに移します。

**実行コマンド**

```plaintext
set -a; . ~/.config/tfstate-backend/backend.env; set +a
terraform init -migrate-state
```

**▼ 実行結果**

```plaintext
Initializing provider plugins found in the configuration...
- Reusing previous version of hashicorp/tls from the dependency lock file
- Reusing previous version of kreuzwerker/docker from the dependency lock file
- Using previously-installed hashicorp/tls v4.3.0
- Using previously-installed kreuzwerker/docker v3.0.2

Initializing the backend...
Do you want to copy existing state to the new backend?
  Pre-existing state was found while migrating the previous "local" backend to the
  newly configured "pg" backend. No existing state was found in the newly
  configured "pg" backend. Do you want to copy this state to the new "pg"
  backend? Enter "yes" to copy and "no" to start with an empty state.

  Enter a value: yes


Successfully configured the backend "pg"! Terraform will automatically
use this backend unless the backend configuration changes.

（途中省略：stateに記録されたプロバイダーの再利用の表示、初期化の後の案内）
```

移行の後の状態を確認します。データベースでは、tfstateの中身は表示せず、行の数と長さだけを見ます。

**実行コマンド**

```plaintext
terraform plan
terraform state list | wc -l
docker exec tfstate-pg psql -U terraform -d terraform_backend -c 'SELECT id, name, length(data) FROM terraform_remote_state.states;'
grep -c 'postgres://' .terraform/terraform.tfstate; echo "exit_code=$?"
ls -l --time-style=full-iso terraform.tfstate terraform.tfstate.backup
git status
```

**▼ 実行結果**

```plaintext
（途中省略：Refreshing state...によるリソース一覧の出力）

No changes. Your infrastructure matches the configuration.

Terraform has compared your real infrastructure against your configuration and found no differences, so no changes are needed.
10
 id |  name   | length
----+---------+--------
  1 | default |  28766
(1 row)

0
exit_code=1
-rw-rw-r-- 1 control control     0 2026-10-07 05:31:03.814120900 +0000 terraform.tfstate
-rw-rw-r-- 1 control control 28767 2026-10-07 05:31:03.814120900 +0000 terraform.tfstate.backup
On branch gitops06-remote-backend
Changes not staged for commit:
  (use "git add <file>..." to update what will be committed)
  (use "git restore <file>..." to discard changes in working directory)
        modified:   main.tf

no changes added to commit (use "git add" and/or "git commit -a")
```

移行の後も、`terraform plan`は「No changes」で、Terraformが把握しているリソースは10個です。**[セクション2](#2-作業ディレクトリに置いたtfstateが消える)** で、tfstateがない状態で新規作成として計画された10個と同じ数です。データベースには`default`の行が1件でき、`.terraform/terraform.tfstate`には接続文字列が書き込まれていません（`0`）。

手元のローカルのtfstateは、`terraform.tfstate`が0バイトになり、移行前の内容は`terraform.tfstate.backup`に残りました。この時点で、mainのパイプラインは、まだこの0バイトのファイルを`-state`で読む構成です。移行のコミットをmainに入れるまで、mainへのマージやプッシュは行いません。

### ■ 検証内容：ワークフローの修正

`gitops-pipeline.yml`から`-state`の指定を外し、`PG_CONN_STR`を渡すようにします。あわせて、ホステッドランナーで動く`drift-check.yml`と`e2e-provisioning-test.yml`も修正します。この2つは、**[第5回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-05/)** のセクション7で整理したとおり、ホステッドランナーの中に別のコンテナを作って動かすワークフローです。ホステッドランナーからは、ホストの`127.0.0.1`で待ち受けるPostgreSQLに届かず、届く必要もありません。

公式ドキュメント（**[Override Files](https://developer.hashicorp.com/terraform/language/files/override)**）では、名前が`_override.tf`で終わるファイルにバックエンドのブロックを書くと、元の設定のバックエンドより常に優先されるとされています。この2つのワークフローでは、`terraform init`の前に、`backend "local" {}`を書いた`backend_override.tf`を作るステップを加え、これまでどおりランナーの中で完結させます。

**実行コマンド**

```plaintext
cd ~/iac/docker-lab-ci
grep -n 'runs-on' .github/workflows/drift-check.yml .github/workflows/e2e-provisioning-test.yml
```

**▼ 実行結果**

```plaintext
.github/workflows/drift-check.yml:13:    runs-on: ubuntu-latest
.github/workflows/e2e-provisioning-test.yml:8:    runs-on: ubuntu-latest
```

修正した後の差分は、次のとおりです。

**実行コマンド**

```plaintext
git --no-pager diff -- .github/workflows/
```

**▼ 実行結果**

```plaintext
diff --git a/.github/workflows/drift-check.yml b/.github/workflows/drift-check.yml
index fdfb52f..bb6d4ee 100644
--- a/.github/workflows/drift-check.yml
+++ b/.github/workflows/drift-check.yml
@@ -14,6 +14,14 @@ jobs:
     steps:
       - uses: actions/checkout@v4
       - uses: hashicorp/setup-terraform@v3
+      - name: Use local backend on this runner
+        working-directory: terraform
+        run: |
+          cat > backend_override.tf <<'EOF'
+          terraform {
+            backend "local" {}
+          }
+          EOF
       - name: Terraform Init
         working-directory: terraform
         run: terraform init
diff --git a/.github/workflows/e2e-provisioning-test.yml b/.github/workflows/e2e-provisioning-test.yml
index c77c464..d1f243c 100644
--- a/.github/workflows/e2e-provisioning-test.yml
+++ b/.github/workflows/e2e-provisioning-test.yml
@@ -11,6 +11,14 @@ jobs:
       - name: Check Docker availability
         run: docker version
       - uses: hashicorp/setup-terraform@v3
+      - name: Use local backend on this runner
+        working-directory: terraform
+        run: |
+          cat > backend_override.tf <<'EOF'
+          terraform {
+            backend "local" {}
+          }
+          EOF
       - name: Terraform Init
         working-directory: terraform
         run: terraform init
diff --git a/.github/workflows/gitops-pipeline.yml b/.github/workflows/gitops-pipeline.yml
index 0b75c57..22da80d 100644
--- a/.github/workflows/gitops-pipeline.yml
+++ b/.github/workflows/gitops-pipeline.yml
@@ -11,6 +11,7 @@ on:
 env:
   TF_VAR_ansible_user_password: ${{ secrets.TF_VAR_ANSIBLE_USER_PASSWORD }}
   TF_VAR_deploy_user_password: ${{ secrets.TF_VAR_DEPLOY_USER_PASSWORD }}
+  PG_CONN_STR: ${{ secrets.PG_CONN_STR }}

 jobs:
   changes:
@@ -45,8 +46,6 @@ jobs:
     needs: changes
     if: github.event_name == 'pull_request' && needs.changes.outputs.terraform == 'true'
     runs-on: [self-hosted, Linux, X64]
-    env:
-      TF_CLI_ARGS_plan: -state=/home/control/iac/docker-lab-ci/terraform/terraform.tfstate
     steps:
       - uses: actions/checkout@v4
       - name: Terraform init
@@ -60,8 +59,6 @@ jobs:
     needs: [changes, terraform-plan]
     if: ${{ !cancelled() && github.event_name == 'pull_request' && needs.terraform-plan.result != 'failure' && (needs.changes.outputs.terraform == 'true' || needs.changes.outputs.ansible == 'true') }}
     runs-on: [self-hosted, Linux, X64]
-    env:
-      TF_CLI_ARGS_output: -state=/home/control/iac/docker-lab-ci/terraform/terraform.tfstate
     steps:
       - uses: actions/checkout@v4
       - name: Add Ansible to PATH
@@ -86,8 +83,6 @@ jobs:
     needs: changes
     if: github.event_name == 'push' && needs.changes.outputs.terraform == 'true'
     runs-on: [self-hosted, Linux, X64]
-    env:
-      TF_CLI_ARGS_apply: -state=/home/control/iac/docker-lab-ci/terraform/terraform.tfstate
     steps:
       - uses: actions/checkout@v4
       - name: Terraform init
@@ -101,8 +96,6 @@ jobs:
     needs: [changes, terraform-apply]
     if: ${{ !cancelled() && github.event_name == 'push' && needs.terraform-apply.result != 'failure' && (needs.changes.outputs.terraform == 'true' || needs.changes.outputs.ansible == 'true') }}
     runs-on: [self-hosted, Linux, X64]
-    env:
-      TF_CLI_ARGS_output: -state=/home/control/iac/docker-lab-ci/terraform/terraform.tfstate
     steps:
       - uses: actions/checkout@v4
       - name: Add Ansible to PATH
```

`PG_CONN_STR`は、ワークフロー全体の`env`に置きました。Terraformのジョブだけでなく、Ansibleのジョブの中の`terraform output`（鍵の書き出しと`dynamic_inventory.py`）でも、pgバックエンドに接続する必要があるためです。

`main.tf`とあわせて作業用のブランチにコミットしてプッシュし、ホステッドランナーの2つのワークフローを、作業用のブランチを指定して手動で実行しました。「Drift Check」の実行（`#193`）は成功しました。実行の番号は、プルリクエストの番号とは別に、ワークフローごとにすべての実行を通して振られます。

**▼ 実行結果（「Drift Check」`#193`、ステップ「Terraform Init」から抜粋）**

```plaintext
Run terraform init
（途中省略：実行したスクリプト、シェル、環境変数の表示）
Initializing the backend...

Successfully configured the backend "local"! Terraform will automatically
use this backend unless the backend configuration changes.

（途中省略：プロバイダーのインストールの表示、初期化の後の案内）
```

**▼ 実行結果（「Drift Check」`#193`、ステップ「Ansible Check Mode」から抜粋）**

```plaintext
（途中省略：コマンドと環境変数の表示、PLAYとTASKの表示、Pythonのインタープリターに関する警告）

PLAY RECAP *********************************************************************
target-node1               : ok=2    changed=1    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0   
target-node2               : ok=2    changed=0    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0   
target-node3               : ok=2    changed=0    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0   

DEBUG: CHANGED value is [1]
```

上書きファイルによってローカルバックエンドで初期化され、改ざんを注入したtarget-node1だけが`changed=1`として検知されました。

「E2E Provisioning Test」の実行（`#17`）でも、「Terraform Init」は「Successfully configured the backend "local"!」と表示し、Testinfraによるテストは「`6 passed`」でした。このワークフローの最後のステップ「Check for dangerous destroy-and-create actions」は、直前のステップで`terraform taint`により鍵の作り直しをわざと起こし、コンテナの削除と作成を検出して止まる確認です。変更前の「E2E Provisioning Test」の実行（`#16`）と同じく、コンテナ3台の削除と作成を検出して、失敗で終わりました。

**▼ 実行結果（「E2E Provisioning Test」`#17`、ステップ「Check for dangerous destroy-and-create actions」から抜粋）**

```plaintext
（途中省略：実行したスクリプト、シェル、環境変数の表示）
danger detected: 3 docker_container resource(s) planned for destroy-and-create
"docker_container.targets[\"target-node1\"]"
"docker_container.targets[\"target-node2\"]"
"docker_container.targets[\"target-node3\"]"
Error: Process completed with exit code 1.
```

### ■ 検証内容：プルリクエストで確認し、マージで適用する

作業用のブランチから、mainへのプルリクエスト（`#15`）を作成しました。このプルリクエストで、「GitOps Pipeline」の実行（`#24`）が起動しました。

**▼ 実行結果（プルリクエスト`#15`の実行`#24`、`changes`ジョブのステップ「Detect changed paths」から抜粋）**

```plaintext
（途中省略：実行したスクリプトと、環境変数の表示）
.github/workflows/drift-check.yml
.github/workflows/e2e-provisioning-test.yml
.github/workflows/gitops-pipeline.yml
terraform/main.tf
terraform=true
***=false
```

`terraform/main.tf`を変えているため、`terraform-plan`と`ansible-check`が動きました。

**▼ 実行結果（実行`#24`、`terraform-plan`ジョブのステップ「Terraform init」から抜粋）**

```plaintext
Run terraform init -input=false -lockfile=readonly
（途中省略：実行したスクリプト、シェル、環境変数の表示、設定に記述されたプロバイダーの再利用の表示）

Initializing the backend...

Successfully configured the backend "pg"! Terraform will automatically
use this backend unless the backend configuration changes.

（途中省略：stateに記録されたプロバイダーの再利用の表示、初期化の後の案内）
```

**▼ 実行結果（実行`#24`、`terraform-plan`ジョブのステップ「Terraform plan」）**

```plaintext
Run terraform plan -input=false
（途中省略：実行したスクリプト、シェル、環境変数の表示、Refreshing state...によるリソース一覧の出力）

No changes. Your infrastructure matches the configuration.

Terraform has compared your real infrastructure against your configuration
and found no differences, so no changes are needed.
```

**▼ 実行結果（実行`#24`、`ansible-check`ジョブのステップ「Ansible check mode」から抜粋）**

```plaintext
（途中省略：コマンドと環境変数の表示、PLAYとTASKの表示、Pythonのインタープリターに関する警告）

PLAY RECAP *********************************************************************
target-node1               : ok=2    changed=0    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0   
target-node2               : ok=2    changed=0    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0   
target-node3               : ok=2    changed=0    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0   
```

続いて、プルリクエスト`#15`をマージしました（マージコミット`a60fa5f`）。このマージで起動した実行（`#25`）では、`changes`の後に`terraform-apply`と`ansible-apply`が動き、確認系の2つのジョブはスキップされました。

![プルリクエスト#15のマージで起動した実行#25。changes、terraform-apply、ansible-applyが成功し、terraform-planとansible-checkはスキップされている](/images/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-06/section3-merge-run.png)

**▼ 実行結果（実行`#25`、`terraform-apply`ジョブのステップ「Terraform apply」から抜粋）**

```plaintext
Run terraform apply -input=false -auto-approve
（途中省略：実行したスクリプト、シェル、環境変数の表示、Refreshing state...によるリソース一覧の出力）

No changes. Your infrastructure matches the configuration.

Terraform has compared your real infrastructure against your configuration
and found no differences, so no changes are needed.

Apply complete! Resources: 0 added, 0 changed, 0 destroyed.

（途中省略：Outputsの表示）
```

**▼ 実行結果（実行`#25`、`ansible-apply`ジョブのステップ「Ansible playbook」から抜粋）**

```plaintext
（途中省略：コマンドと環境変数の表示、PLAYとTASKの表示、Pythonのインタープリターに関する警告）

PLAY RECAP *********************************************************************
target-node1               : ok=2    changed=0    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0   
target-node2               : ok=2    changed=0    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0   
target-node3               : ok=2    changed=0    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
```

手元のmainも更新しました。

**実行コマンド**

```plaintext
cd ~/iac/docker-lab-ci
git switch main
git pull
git log --oneline --graph -3
```

**▼ 実行結果**

```plaintext
Switched to branch 'main'
Your branch is up to date with 'origin/main'.
（途中省略：オブジェクトの受信の表示）
From https://github.com/juehara-crypto/ansible-terraform-ci-lab
   a235999..a60fa5f  main       -> origin/main
Updating a235999..a60fa5f
Fast-forward
 .github/workflows/drift-check.yml           | 8 ++++++++
 .github/workflows/e2e-provisioning-test.yml | 8 ++++++++
 .github/workflows/gitops-pipeline.yml       | 9 +--------
 terraform/main.tf                           | 2 ++
 4 files changed, 19 insertions(+), 8 deletions(-)
*   a60fa5f (HEAD -> main, origin/main) Merge pull request #15 from juehara-crypto/gitops06-remote-backend
|\
| * dc27084 (origin/gitops06-remote-backend, gitops06-remote-backend) GitOps第6回: tfstateをpgバックエンドに移し、ワークフローから-stateを外す
|/
*   a235999 Merge pull request #14 from juehara-crypto/gitops05-cleanup-terraform
|\
```

### ■ 検証内容：移行の後に残ったファイル

ランナーの作業ディレクトリと、手元に残ったローカルのtfstateを確認します。

**実行コマンド**

```plaintext
cd ~/iac/docker-lab-ci/terraform
ls -l --time-style=full-iso terraform.tfstate terraform.tfstate.backup
RUNNER_WS=~/actions-runner/_work/ansible-terraform-ci-lab/ansible-terraform-ci-lab
ls -la "$RUNNER_WS/terraform/" | grep -E 'tfstate|\.terraform$'
grep -c 'postgres://' "$RUNNER_WS/terraform/.terraform/terraform.tfstate"; echo "exit_code=$?"
ls -l "$RUNNER_WS/ansible/id_ed25519_generated"; echo "exit_code=$?"
```

**▼ 実行結果**

```plaintext
-rw-rw-r-- 1 control control     0 2026-10-07 05:31:03.814120900 +0000 terraform.tfstate
-rw-rw-r-- 1 control control 28767 2026-10-07 05:31:03.814120900 +0000 terraform.tfstate.backup
drwxr-xr-x 3 control control 4096 Oct  7 06:31 .terraform
0
exit_code=1
ls: cannot access '/home/control/actions-runner/_work/ansible-terraform-ci-lab/ansible-terraform-ci-lab/ansible/id_ed25519_generated': No such file or directory
exit_code=2
```

ランナーの作業ディレクトリには、tfstateはありません。ジョブの`.terraform/`にも接続文字列は書き込まれておらず、ジョブで書き出した鍵は削除されています。

手元の`terraform.tfstate.backup`には、秘密鍵を含む移行前のtfstateが、他のユーザーからも読める権限のまま残っています。権限を`0600`に絞り、使われなくなった0バイトの`terraform.tfstate`は削除します。

**実行コマンド**

```plaintext
chmod 600 terraform.tfstate.backup
rm terraform.tfstate
ls -l terraform.tfstate.backup terraform.tfstate; echo "exit_code=$?"
set -a; . ~/.config/tfstate-backend/backend.env; set +a
terraform plan
```

**▼ 実行結果**

```plaintext
ls: cannot access 'terraform.tfstate': No such file or directory
-rw------- 1 control control 28767 Oct  7 05:31 terraform.tfstate.backup
exit_code=2
（途中省略：Refreshing state...によるリソース一覧の出力）

No changes. Your infrastructure matches the configuration.

Terraform has compared your real infrastructure against your configuration and found no differences, so no changes are needed.
```

ローカルの`terraform.tfstate`を削除した後も、手元の`terraform plan`は「No changes」でした。手元の`terraform`も、pgバックエンドのtfstateを読んでいます。

### ■ 結果

tfstateの置き場所を、ランナーホスト上のファイルからpgバックエンドに移しました。移行の前後の構成を並べると、次のとおりです。

|項目|移行の前（**[第5回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-05/)**）|移行の後|
|---|---|---|
|tfstateの置き場所|ランナーホストの`terraform/terraform.tfstate`|PostgreSQLの`terraform_remote_state.states`|
|パイプラインからの指定|ジョブごとの`TF_CLI_ARGS_*`で`-state`を指定|`main.tf`の`backend "pg" {}`と、Secretsから渡す`PG_CONN_STR`|
|非推奨の警告|`terraform plan`、`terraform apply`のたびに出る|出ない|
|手元からの`terraform`の実行|作業ディレクトリのtfstateを読む|`PG_CONN_STR`を読み込んでから実行する|
|ホステッドランナーの2つのワークフロー|ランナーの中のローカルのtfstate|上書きファイルで、ランナーの中のローカルのtfstateのまま|

移行の前後とも、`terraform plan`は「No changes」でした。移行の後にTerraformが把握しているリソースは10個で、**[セクション2](#2-作業ディレクトリに置いたtfstateが消える)** で新規作成として計画された数と同じです。プルリクエストの確認系とマージの適用系の両方で、**[第5回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-05/)** から残していた非推奨の警告は出なくなりました。

Ansibleのジョブで、インベントリと鍵を用意する手順は、変えていません。`dynamic_inventory.py`も、鍵を書き出すステップも、`terraform output`を実行するだけで、tfstateがどこにあるかを知りません。tfstateの置き場所はTerraformのバックエンドの設定で決まり、`terraform output`はその設定に従って読みます。**[第5回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-05/)** でAnsibleに渡す接続先を`terraform output`経由にしていたため、置き場所を変えても、Ansibleの側には変更が及びませんでした。

一方で、移行の途中には、注意が必要な時間がありました。手元で`terraform init -migrate-state`を実行してから、移行のコミットがmainに入るまでの間、mainのパイプラインは、中身が0バイトになったローカルのtfstateを`-state`で読む構成のままでした。この間にmainへのマージやプッシュがあれば、**[セクション2](#2-作業ディレクトリに置いたtfstateが消える)** の2回目の実行と同じく、空のtfstateで計画が作られていたことになります。置き場所の移行は、手元の操作とパイプラインの設定の変更が1つのコミットにまとまらないため、その間の実行を止めておく必要があります。

なお、この検証環境では、PostgreSQLのコンテナも、ランナーと同じホストの上にあります。「ランナーを増やしても共有できるか」の基準を満たすのは、バックエンドがランナーから届く場所にあるからで、同じホストにあるからではありません。ランナーを別のホストに増やす場合は、PostgreSQLを`127.0.0.1`以外でも待ち受けさせ、接続の経路と認証を設計し直す必要があります。

pgバックエンドで、tfstateは消えず、ランナーを増やしても共有できる置き場所になりました。ただし、ロックが実際に効くかは、まだ確かめていません。ロックの確認は、同時実行の経路を整理した後、**[セクション5](#5-パイプライン層とツール層の二重の保護)** で行います。

次のセクションでは、同時実行がどこで起きるのかを整理します。

---

[↑ 目次に戻る](#-目次)

---

## 4. 同時実行はどこで起きるのか

tfstateと操作対象に対して、複数の実行が重なる経路を整理します。

### 重なるのは、tfstateと操作対象の2つ

**[セクション3](#3-tfstateの置き場所を選ぶ)** で、tfstateは、ランナーと手元のどちらからも同じものを読み書きする置き場所になりました。置き場所が1つにまとまったことで、複数の実行が同じtfstateに同時に触れる可能性も、1か所に集まります。

複数の実行が重なったときに影響を受けるものは、2つあります。

* tfstate：`terraform apply`が読み、書き換える。2つの`terraform apply`が同時に書き換えると、一方の結果がもう一方で上書きされるおそれがある
* 操作対象：`terraform apply`がコンテナそのものを作り、`ansible-playbook`がコンテナの中の設定を変える。2つの実行が同じ操作対象を同時に変えると、どちらの結果が残るかが実行のタイミングで決まる

Ansibleは、tfstateを書き換えません。**[第5回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-05/)** で組んだパイプラインでは、Ansibleのジョブは`terraform output`で接続先と鍵を読むだけです。一方、操作対象のOSの中は、Ansibleが変える場所です。tfstateを守る仕組みと、操作対象のOSの中を守る仕組みは、分けて考える必要があります。

### 同時実行が起きる3つの経路

この回の構成で、複数の実行が重なる経路は、次の3つです。

|経路|重なる実行|
|---|---|
|連続したマージ|mainへのマージが短い間隔で続き、パイプラインの実行同士が重なる|
|手元からの実行|パイプラインの実行中に、手元から`terraform apply`や`ansible-playbook`を実行する|
|ランナーの増設|ランナーを複数にしたとき、別々のランナーで動くジョブ同士が重なる|

1つ目の経路は、パイプラインの中で起きます。**[第5回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-05/)** のパイプラインでは、1回の実行が`changes`、`terraform-apply`、`ansible-apply`のジョブに分かれています。2つの実行が重なるときは、実行の単位だけでなく、ジョブの単位で、どのジョブとどのジョブが重なるかを考える必要があります。たとえば、先の実行の`ansible-apply`と、後の実行の`terraform-apply`が重なれば、Ansibleが設定しているコンテナを、Terraformが同時に作り直すことになります。この構成で、連続したマージの実行がどう進むかは、**[セクション5](#5-パイプライン層とツール層の二重の保護)** で実機で確認します。

2つ目の経路は、パイプラインの外から入ります。**[第1回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part1/ansible-gitops-part1-01/)** のセクション6では、Gitを経由しない手動変更を、「唯一の真実」が崩れる経路の1つとして整理しました。手元からの`terraform apply`や`ansible-playbook`は、Gitに入ったコードを使う場合でも、パイプラインを通らない実行です。障害対応のように、手元からの実行が必要になる場面もあり、その扱いは **[第20回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part4/ansible-gitops-part4-20/)** で扱います。この回では、パイプラインの外からの実行が、パイプラインの実行と重なりうることだけを押さえます。

3つ目の経路は、この検証環境のランナーが1台なので、実機では再現しません。ただし、**[セクション3](#3-tfstateの置き場所を選ぶ)** でtfstateを共有できる置き場所に移したことで、ランナーを増やしたときにも、すべてのランナーが同じtfstateを読み書きします。共有できる置き場所を選んだことは、同時に、すべてのランナーの実行が同じtfstateの上で重なりうることも意味します。

### どの経路を、どこで止めるのか

3つの経路は、パイプラインの中で起きるものと、外から入るものに分かれます。パイプラインの中で起きる重なりは、パイプラインの側で実行の順番を決めれば防げる可能性があります。外から入る重なりは、パイプラインの側の設定では止められず、ツールの側の仕組みが必要になります。

Terraformには、tfstateを読み書きする間、ほかの実行を待たせるstateロックがあります。stateロックは、どこから実行したかに関係なく、同じバックエンドを使う実行すべてに効くはずです。一方、Ansibleには、tfstateにあたる記録がなく、stateロックに相当する仕組みもありません。

次のセクションでは、パイプライン層の直列化と、ツール層のstateロックが、それぞれの経路をどこまで止めるかを実機で確認します。

---

[↑ 目次に戻る](#-目次)

---

## 5. パイプライン層とツール層の二重の保護

**[セクション4](#4-同時実行はどこで起きるのか)** で整理した経路に対して、ツール層のstateロックと、パイプライン層の直列化が、それぞれどこまで止めるかを実機で確認します。最後に、Ansibleの同時実行を確認します。

### ツール層：Terraformのstateロック

**[セクション3](#3-tfstateの置き場所を選ぶ)** で確認したとおり、pgバックエンドは、PostgreSQLのadvisory lockでロックします。公式ドキュメント（**[pg](https://developer.hashicorp.com/terraform/language/backend/pg)**）では、このロックはセッションが終わったり接続が切れたりすると自動で外れるため、`terraform force-unlock`には対応していないとされています。

ロックはバックエンドの側にかかるため、パイプラインの中の実行か、手元からの実行かには関係しないはずです。手元の`terraform apply`がロックを持っている間に、パイプラインの`terraform plan`がどうなるかを確かめます。

### ■ 検証内容：手元のterraform applyがロックを持っている間のパイプライン

`terraform/`を変えるプルリクエスト用のブランチを用意します。コメント行を1行加えるだけなので、計画に差分は出ません。

**実行コマンド**

```plaintext
cd ~/iac/docker-lab-ci
git switch -c gitops06-lock-check
echo '# GitOps第6回: stateロックの確認用' >> terraform/main.tf
git add terraform/main.tf
git commit -m "GitOps第6回: stateロックの確認用のコメント行を追加"
git push -u origin gitops06-lock-check
git switch main
```

手元の`terraform apply`を確認プロンプトで止めて、ロックを持ったままにします。確認プロンプトを出すには、計画に変更が必要です。そこで、何も作らない組み込みのリソース`terraform_data`を、手元の`main.tf`に一時的に加えます。コミットはしません。

**実行コマンド（ターミナル1）**

```plaintext
cd ~/iac/docker-lab-ci/terraform
cat >> main.tf <<'EOF'

resource "terraform_data" "lock_check" {}
EOF
git --no-pager diff
set -a; . ~/.config/tfstate-backend/backend.env; set +a
terraform apply
```

**▼ 実行結果（ターミナル1）**

```plaintext
diff --git a/terraform/main.tf b/terraform/main.tf
index 4b059ba..d1e86d4 100644
--- a/terraform/main.tf
+++ b/terraform/main.tf
@@ -132,3 +132,5 @@ output "target_nodes_ips" {
 resource "tls_private_key" "generated" {
   algorithm = "ED25519"
 }
+
+resource "terraform_data" "lock_check" {}
（途中省略：Refreshing state...によるリソース一覧の出力）

Terraform used the selected providers to generate the following execution plan. Resource actions are indicated with the following symbols:
  + create

Terraform will perform the following actions:

  # terraform_data.lock_check will be created
  + resource "terraform_data" "lock_check" {
      + id = (known after apply)
    }

Plan: 1 to add, 0 to change, 0 to destroy.

Do you want to perform these actions?
  Terraform will perform the actions described above.
  Only 'yes' will be accepted to approve.

  Enter a value:
```

確認プロンプトで止めたまま、別のターミナルで、PostgreSQLのadvisory lockを確認します。

**実行コマンド（ターミナル2）**

```plaintext
docker exec tfstate-pg psql -U terraform -d terraform_backend -c "SELECT locktype, objid, mode, granted FROM pg_locks WHERE locktype = 'advisory';"
```

**▼ 実行結果（ターミナル2）**

```plaintext
 locktype | objid |     mode      | granted
----------+-------+---------------+---------
 advisory |     1 | ExclusiveLock | t
(1 row)
```

ロックが1件保持されています（`granted`が`t`）。`objid`の`1`は、**[セクション3](#3-tfstateの置き場所を選ぶ)** で確認した`states`テーブルの`default`の行の`id`と同じです。

この状態で、用意したブランチからmainへのプルリクエスト（`#16`）を作成しました。このプルリクエストで起動した実行（`#26`）では、`terraform-plan`が失敗し、`ansible-check`は動きませんでした。

![プルリクエスト#16で起動した実行#26。terraform-planが失敗し、ansible-checkはスキップされている](/images/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-06/section5-lock-error-run.png)

**▼ 実行結果（実行`#26`、`terraform-plan`ジョブのステップ「Terraform plan」）**

```plaintext
Run terraform plan -input=false
（途中省略：実行したスクリプト、シェル、環境変数の表示）
╷
│ Error: Error acquiring the state lock
│ 
│ Error message: Workspace is already locked: default
│ Lock Info:
│   ID:        5aab5415-cb37-ec78-bd08-67a01b8392c6
│   Path:      
│   Operation: OperationTypePlan
│   Who:       control@ubuntu-controller
│   Version:   1.15.7
│   Created:   2026-10-07 07:40:18.340581003 +0000 UTC
│   Info:      
│ 
│ 
│ Terraform acquires a state lock to protect the state from being written
│ by multiple users at the same time. Please resolve the issue above and try
│ again. For most commands, you can disable locking with the "-lock=false"
│ flag, but this is not recommended.
╵
Error: Process completed with exit code 1.
```

最後に、ターミナル1の確認プロンプトに`no`と答えてロックを解放し、手元の`main.tf`を元に戻します。

**▼ 実行結果（ターミナル1、確認プロンプトに答えた後）**

```plaintext
（途中省略：上と同じ計画の表示と、確認の文言）
  Enter a value: no

Apply cancelled.
```

**実行コマンド**

```plaintext
git restore main.tf
git status
terraform plan
docker exec tfstate-pg psql -U terraform -d terraform_backend -c "SELECT locktype, objid, mode, granted FROM pg_locks WHERE locktype = 'advisory';"
```

**▼ 実行結果**

```plaintext
On branch main
Your branch is up to date with 'origin/main'.

nothing to commit, working tree clean
（途中省略：Refreshing state...によるリソース一覧の出力）

No changes. Your infrastructure matches the configuration.

Terraform has compared your real infrastructure against your configuration and found no differences, so no changes are needed.
 locktype | objid | mode | granted
----------+-------+------+---------
(0 rows)
```

### ■ 結果

手元の`terraform apply`がロックを持っている間、パイプラインの`terraform plan`は、`Error acquiring the state lock`（`Workspace is already locked: default`）で止まりました。`terraform-plan`のジョブが失敗したため、**[第5回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-05/)** で組んだ条件式によって、`ansible-check`も動いていません。手元で確認プロンプトに`no`と答えると、ロックは外れ、`pg_locks`のadvisory lockは0件になりました。

stateロックは、パイプラインの外からの実行と、パイプラインの中の実行の間でも効きました。ロックがかかるのはバックエンドの側で、どこから`terraform`を実行したかには関係しないためです。

一方、エラーに表示された`Lock Info`は、ロックを持っている手元の`terraform apply`の情報とは合いません。`Operation`は`OperationTypePlan`で、`Created`の時刻は、手元で`terraform apply`を始めた時刻より後の、実行`#26`の時刻です。表示されているのは、ロックを取ろうとして失敗したパイプラインの`terraform plan`の情報と読めます。この検証環境のpgバックエンドでは、エラーの`Lock Info`から、誰がロックを持っているかは分かりませんでした。ロックを持っている実行を探すには、パイプラインの実行の一覧や、手元の作業の状況と突き合わせる必要があります。

### パイプライン層：concurrencyによる直列化

GitHub Actionsでは、`concurrency`でグループを指定すると、同じグループの実行は1度に1つしか動かなくなります。公式ドキュメント（**[Control the concurrency of workflows and jobs](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency)**）では、次のように説明されています。

* 同じリポジトリの中で、同じグループの実行が動いていれば、後から来た実行は待機（`pending`）になる
* 既定（`queue: single`）では、待機できるのは1つだけで、新しい実行が来ると、待機中の実行は取り消されて置き換わる
* `queue: max`を指定すると、最大100件まで待機でき、待ち始めた順に1つずつ実行される。ただし、実際の開始の時刻にはずれがあるため、順番は保証されない
* `queue: max`と、実行中のものを取り消す`cancel-in-progress: true`は、同時には指定できない

**[セクション4](#4-同時実行はどこで起きるのか)** で整理したとおり、パイプラインの1回の実行は、複数のジョブに分かれています。ジョブ単位ではなく、ワークフロー全体に`concurrency`を指定し、1回の実行の`terraform-apply`から`ansible-apply`までが、別の実行と重ならないようにします。グループ名は`gitops-pipeline`に固定し、プルリクエストの実行も、mainへのプッシュの実行も、同じグループに入れます。

### ■ 検証内容：既定のconcurrencyで、続けてマージしたときの実行

まず、`queue`を指定しない既定の動きで、`concurrency`を加えます。

**実行コマンド**

```plaintext
sed -i 's/^env:$/concurrency:\n  group: gitops-pipeline\n\nenv:/' .github/workflows/gitops-pipeline.yml
git --no-pager diff
```

**▼ 実行結果**

```plaintext
diff --git a/.github/workflows/gitops-pipeline.yml b/.github/workflows/gitops-pipeline.yml
index 22da80d..4b933b9 100644
--- a/.github/workflows/gitops-pipeline.yml
+++ b/.github/workflows/gitops-pipeline.yml
@@ -8,6 +8,9 @@ on:
     branches:
       - main

+concurrency:
+  group: gitops-pipeline
+
 env:
   TF_VAR_ansible_user_password: ${{ secrets.TF_VAR_ANSIBLE_USER_PASSWORD }}
   TF_VAR_deploy_user_password: ${{ secrets.TF_VAR_DEPLOY_USER_PASSWORD }}
```

この変更をプルリクエスト（`#17`）にしてマージしました（マージコミット`ccc6bd3`）。

続いて、`terraform/`にコメント行を1行加えるだけのプルリクエストを4つ作りました。`#20`と`#22`は`terraform/outputs.tf`、`#21`と`#23`は`terraform/main.tf`への追加です。`terraform/`の変更なので、マージすると`terraform-apply`と`ansible-apply`の両方が動きます。

`#20`と`#21`は、続けてマージしました。その後、`#22`と`#23`のプルリクエストを続けて作成し、`#23`は、そのプルリクエストの確認の実行が始まる前にマージしました。**[第3回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part1/ansible-gitops-part1-03/)** のセクション5で確認したとおり、この検証環境では、確認が終わる前のマージも止められません。

次の画像は、「GitOps Pipeline」の実行の一覧です。`#20`と`#21`のマージの実行（`#35`、`#36`）、`#22`と`#23`のプルリクエストの実行（`#37`、`#38`）、`#23`のマージの実行（`#39`）が写っています。

![GitOps Pipelineの実行の一覧。#20のマージの実行#35、#21のマージの実行#36、#22のプルリクエストの実行#37は成功、#23のプルリクエストの実行#38は取り消し、#23のマージの実行#39は成功](/images/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-06/section5-default-queue-runs.png)

一覧の所要時間と状態を並べると、次のとおりです。

|実行|きっかけ|状態|所要時間|
|---|---|---|---|
|`#35`|`#20`のマージ|成功|1分4秒|
|`#36`|`#21`のマージ|成功|1分50秒|
|`#37`|`#22`のプルリクエスト|成功|1分2秒|
|`#38`|`#23`のプルリクエスト|取り消し|7秒|
|`#39`|`#23`のマージ|成功|2分40秒|

実行`#38`を開くと、Statusは`Cancelled`で、`changes`を含むすべてのジョブが一度も動いていませんでした。

![#23のプルリクエストの実行#38。StatusはCancelledで、changesを含むすべてのジョブが動いていない](/images/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-06/section5-cancelled-pr-run.png)

### ■ 結果

`#20`と`#21`のマージの実行は、どちらも成功しました。`#36`の所要時間は1分50秒で、ほぼ同じ内容の`#35`（1分4秒）より長くなっています。`#36`は、`#35`が終わるまで待機してから動いたと考えられます。2つの実行は、重ならずに順に動きました。

`#22`と`#23`では、取り消しが起きました。公式ドキュメントの仕様と、一覧の状態から、次の流れと考えられます。

1. `#37`（`#22`のプルリクエストの実行）が動いている間に、`#38`（`#23`のプルリクエストの実行）が待機に入った
2. `#23`がマージされ、`#39`（`#23`のマージの実行）が同じグループに来た
3. 待機できるのは1つだけなので、待機していた`#38`が取り消され、`#39`に置き換わった
4. `#39`は、`#37`が終わるまで待ってから動いた（2分40秒）

その結果、`#23`は、プルリクエストの確認が一度も動かないまま、マージされて適用されました。グループ名を1つにしたことで、プルリクエストの実行とmainへのプッシュの実行が、同じ1つの待機の枠を取り合ったためです。

既定の動きには、もう1つ問題があります。**[第5回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-05/)** の`changes`ジョブは、mainへのプッシュでは、プッシュの前のコミット（`github.event.before`）とプッシュの後のコミットを比べて、変更されたパスを判定します。マージの実行が待機中に取り消されると、そのマージに含まれていた変更は、次のマージの実行の判定には含まれません。たとえば、`terraform/`を変えたマージの実行が取り消され、次のマージが`ansible/`だけの変更であれば、`terraform-apply`は一度も動かないまま、mainだけが先に進みます。この動きは、公式ドキュメントの仕様と **[第5回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-05/)** の判定の方法から導いたもので、マージの実行の取り消しは、実機では再現していません。

GitOpsでは、最新のmainが適用されていれば、途中のコミットの実行を飛ばしても問題がないように見えます。しかし、パスによってジョブを切り替える構成では、実行を飛ばすことは、その実行が判定するはずだった変更を飛ばすことになります。

### ■ 検証内容：待機をqueue: maxにする

待機中の実行が取り消されないよう、`queue: max`を加えます。

**実行コマンド**

```plaintext
sed -i 's/^  group: gitops-pipeline$/  group: gitops-pipeline\n  queue: max/' .github/workflows/gitops-pipeline.yml
git --no-pager diff
```

**▼ 実行結果**

```plaintext
diff --git a/.github/workflows/gitops-pipeline.yml b/.github/workflows/gitops-pipeline.yml
index 4b933b9..90cbc7a 100644
--- a/.github/workflows/gitops-pipeline.yml
+++ b/.github/workflows/gitops-pipeline.yml
@@ -10,6 +10,7 @@ on:

 concurrency:
   group: gitops-pipeline
+  queue: max

 env:
   TF_VAR_ansible_user_password: ${{ secrets.TF_VAR_ANSIBLE_USER_PASSWORD }}
```

この変更をプルリクエスト（`#24`）にしてマージしました（マージコミット`9e0acf4`）。プルリクエストの確認も、マージの実行（`#41`）も成功し、`queue: max`の指定は、ワークフローの文法の確認で弾かれませんでした。

### ■ 結果

パイプライン層の直列化は、`concurrency`をワークフロー全体に指定することで効きました。ただし、既定の動きでは、待機できる実行は1つだけで、待機中の実行は、後から来た実行に置き換えられて取り消されます。実際に、プルリクエストの確認の実行が取り消され、確認が一度も動かないままマージされたプルリクエストが出ました。

`queue: max`にすると、待機中の実行は取り消されず、待ち始めた順に動きます。この回では、`queue: max`を加えた後に、複数の実行が待機する状況は再現していません。待機中の実行が順に動くことは、公式ドキュメントの仕様に基づく説明です。

### Ansibleにはロックがない

Terraformには、tfstateを読み書きする間、ほかの実行を止めるstateロックがあります。Ansibleには、tfstateにあたる記録がなく、同じホストへの別の実行を止める仕組みもありません。同じ3台に対して、2本のAnsibleを同時に実行して確かめます。

### ■ 検証内容：同じ3台に対する2本のAnsible

各ホストで15秒待つだけのコマンドを、2本同時に実行します。2本が互いに待てば、全体で30秒以上かかります。互いに待たなければ、15秒台で終わります。各ホストでの開始と終了の時刻も表示させます。設定は何も変えません。

**実行コマンド**

```plaintext
cd ~/iac/docker-lab-ci/ansible
set -a; . ~/.config/tfstate-backend/backend.env; set +a
date '+all start %T'
( ansible target_nodes -i dynamic_inventory.py -m ansible.builtin.shell -a 'echo run1 start $(date +%T); sleep 15; echo run1 end $(date +%T)' -o > /tmp/gitops06-run1.log 2>&1; echo "run1 exit_code=$?" >> /tmp/gitops06-run1.log ) &
( ansible target_nodes -i dynamic_inventory.py -m ansible.builtin.shell -a 'echo run2 start $(date +%T); sleep 15; echo run2 end $(date +%T)' -o > /tmp/gitops06-run2.log 2>&1; echo "run2 exit_code=$?" >> /tmp/gitops06-run2.log ) &
wait
date '+all end %T'
cat /tmp/gitops06-run1.log /tmp/gitops06-run2.log
rm /tmp/gitops06-run1.log /tmp/gitops06-run2.log
```

**▼ 実行結果**

```plaintext
all start 09:20:56
[1] 34319
[2] 34321
（途中省略：2つのバックグラウンドの処理の終了の表示）
all end 09:21:16
target-node1 | CHANGED | rc=0 | (stdout) run1 start 09:21:01\nrun1 end 09:21:16
target-node3 | CHANGED | rc=0 | (stdout) run1 start 09:21:01\nrun1 end 09:21:16
target-node2 | CHANGED | rc=0 | (stdout) run1 start 09:21:01\nrun1 end 09:21:16
run1 exit_code=0
target-node1 | CHANGED | rc=0 | (stdout) run2 start 09:21:00\nrun2 end 09:21:15
target-node3 | CHANGED | rc=0 | (stdout) run2 start 09:21:01\nrun2 end 09:21:16
target-node2 | CHANGED | rc=0 | (stdout) run2 start 09:21:01\nrun2 end 09:21:16
run2 exit_code=0
```

### ■ 結果

全体の時間は20秒で、3台のどのホストでも、2本の実行がほぼ同じ時刻（`09:21:00`〜`09:21:01`）に始まり、ほぼ同じ時刻（`09:21:15`〜`09:21:16`）に終わりました。どちらもエラーにならず（`exit_code=0`）、互いを待つこともありませんでした。

Terraformでは、手元の`terraform apply`がロックを持っている間、パイプラインの`terraform plan`は止められました。Ansibleでは、同じホストに対する2本の実行が、互いに止められることなく、同時に動きました。2本が同じ設定ファイルを別々の内容に書き換えるものであれば、どちらの内容が残るかは、実行のタイミングで決まります。

なお、2本の`dynamic_inventory.py`は、どちらも`terraform output`でpgバックエンドのtfstateを読んでいますが、どちらも失敗していません。

### ■ 検証内容：確認用のコメント行の削除と、終了時点の状態

確認のために加えたコメント行を、プルリクエスト（`#25`）で取り除きました（マージコミット`307c83a`）。このマージの実行（`#43`）は成功しました。終了時点の状態を確認します。

**実行コマンド**

```plaintext
cd ~/iac/docker-lab-ci
grep -rn '^# GitOps第6回: ' terraform/ ansible/; echo "exit_code=$?"
sed -n '/^concurrency:/,/^$/p' .github/workflows/gitops-pipeline.yml
cd ~/iac/docker-lab-ci/terraform
set -a; . ~/.config/tfstate-backend/backend.env; set +a
terraform plan
cd ~/iac/docker-lab-ci/ansible
ansible-playbook -i dynamic_inventory.py site.yml --check
```

**▼ 実行結果**

```plaintext
exit_code=1
concurrency:
  group: gitops-pipeline
  queue: max

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

**[セクション4](#4-同時実行はどこで起きるのか)** の3つの経路に対して、どの層が何を守るかを並べると、次のとおりです。

|経路|パイプライン層（`concurrency`）|ツール層（Terraformのstateロック）|Ansibleが変える操作対象のOSの中|
|---|---|---|---|
|連続したマージ|直列化される。既定では待機中の実行が取り消されるため、`queue: max`が必要|効く|パイプライン層の直列化でだけ守られる|
|手元からの実行|効かない（パイプラインを通らない）|効く（この回で確認）|守る仕組みがない（この回で確認）|
|ランナーの増設|グループは同じリポジトリの中で判定されるため、ランナーの数に関係なく効くと考えられる（実機では未確認）|同じバックエンドを使えば効く|パイプライン層の直列化でだけ守られる|

Terraformは、パイプライン層とツール層の二重で守られます。パイプラインの外からの`terraform apply`も、stateロックで止まります。一方、Ansibleを守るのは、パイプライン層の直列化だけです。パイプラインの外から手元で実行した`ansible-playbook`は、パイプラインの実行とも、ほかの手元の実行とも、互いに止められずに同時に動きます。

Ansibleの同時実行を止められるのは、パイプラインを通る実行の間だけです。手元から直接実行するAnsibleは、どの層でも止められないため、パイプラインの外からの実行そのものを減らすか、起きた後に、Gitの内容とのずれとして検知して戻すしかありません。手元からの実行が必要になる障害対応との両立は **[第20回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part4/ansible-gitops-part4-20/)** で、ずれの検知と収束は第4部（**[第17回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part4/ansible-gitops-part4-17/)** 〜 **[第21回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part4/ansible-gitops-part4-21/)**）で扱います。

次のセクションでは、この回の設計が、AWSやGCPのプロバイダーでも変わらないことを整理します。

---

[↑ 目次に戻る](#-目次)

---

## 6. クラウドプロバイダーでも設計は変わらない

この回で組んだtfstateの置き場所と同時実行の制御を、AWSやGCPのプロバイダーに切り替えた場合に、何が置き換わり、何が変わらないかを整理します。クラウドでの実行は行っていないため、ここでは公式ドキュメントの記述と、この回の構成を並べて比べます。

### 置き換わるのは、バックエンドの設定と認証情報

この回では、tfstateの置き場所に、PostgreSQLを使うpgバックエンドを使いました。AWSではS3、GCPではGCSのバックエンドが、同じ役割（リモートの置き場所とロック）を担います。

|項目|この回の検証環境|AWS|GCP|
|---|---|---|---|
|バックエンド|`pg`|`s3`|`gcs`|
|置き場所|PostgreSQLのテーブル（`terraform_remote_state.states`）|S3のバケットの中のオブジェクト|GCSのバケットの中のオブジェクト|
|ロック|PostgreSQLのadvisory lock（既定で有効）|`use_lockfile = true`で有効にする（既定では無効）|対応している|
|事前に用意するもの|データベース（`terraform_backend`）|バケット|バケット|
|認証情報|接続文字列（`PG_CONN_STR`）|AWSの認証情報|Google Cloudの認証情報|

S3のバックエンドでは、ロックは自分で有効にする機能です（**[s3](https://developer.hashicorp.com/terraform/language/backend/s3)**）。`use_lockfile`を`true`にすると、tfstateと同じバケットにロック用のファイルを置いてロックします。以前から使われてきたDynamoDBによるロックは非推奨とされ、今後のバージョンで削除される予定と書かれています。GCSのバックエンドは、ロックに対応しています（**[gcs](https://developer.hashicorp.com/terraform/language/backend/gcs)**）。どちらのドキュメントでも、誤って削除したときに戻せるよう、バケットのバージョニングを有効にすることが強く推奨されています。

設定は、たとえば次のような形になります（クラウドでは実行していません）。

* **ファイル名：`terraform/main.tf`（AWSの場合の例）**

```hcl
terraform {
  backend "s3" {
    bucket       = "example-tfstate-bucket"
    key          = "gitops/terraform.tfstate"
    region       = "ap-northeast-1"
    use_lockfile = true
  }
}
```

* **ファイル名：`terraform/main.tf`（GCPの場合の例）**

```hcl
terraform {
  backend "gcs" {
    bucket = "example-tfstate-bucket"
    prefix = "gitops"
  }
}
```

認証情報の扱いは、pgバックエンドと同じです。S3とGCSのドキュメントでも、認証情報などの機密の値を設定ファイルや`-backend-config`に書くと、`.terraform/`のディレクトリと保存したplanに値が残るため、環境変数で渡すよう推奨されています。パイプラインでは、この回の`PG_CONN_STR`の代わりに、クラウドの認証情報をジョブに渡すことになります。認証情報をどこに置き、どこまで外部に預けるかは、第3部（**[第13回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part3/ansible-gitops-part3-13/)** 〜 **[第16回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part3/ansible-gitops-part3-16/)**）で扱います。

もう1つ、バックエンドの置き場所そのものを、同じTerraformで管理しないという点も共通です。**[セクション3](#3-tfstateの置き場所を選ぶ)** では、PostgreSQLのコンテナを、Terraformの管理に入れずに起動しました。S3のバックエンドのドキュメントでも、Terraformが使う基盤は、Terraformが管理する基盤の外に置くことが望ましいとされています。S3やGCSのバケットも、そのバケットにtfstateを置くTerraformとは別に用意します。

### 変わらないもの

プロバイダーを切り替えても、この回で設計した次のものは変わりません。

|設計|プロバイダーを切り替えたとき|
|---|---|
|作業ディレクトリにtfstateを置かない（**[セクション2](#2-作業ディレクトリに置いたtfstateが消える)**）|変わらない。チェックアウトの掃除はGitHub Actionsの側の動きで、プロバイダーに関係しない|
|置き場所を「消えないか」「ロックが効くか」「共有できるか」で選ぶ（**[セクション3](#3-tfstateの置き場所を選ぶ)**）|変わらない。S3やGCSを選ぶ理由も、この3つの基準で説明できる|
|Ansibleは`terraform output`経由で接続先と鍵を読む（**[セクション3](#3-tfstateの置き場所を選ぶ)**）|変わらない。`dynamic_inventory.py`も鍵を書き出すステップも、tfstateの置き場所を知らない|
|ホステッドランナーのワークフローは上書きファイルでローカルのtfstateにする（**[セクション3](#3-tfstateの置き場所を選ぶ)**）|変わらない。上書きファイルが元のバックエンドより優先される仕組みは、バックエンドの種類に関係しない|
|ワークフロー全体の`concurrency`と`queue: max`による直列化（**[セクション5](#5-パイプライン層とツール層の二重の保護)**）|変わらない。GitHub Actionsの側の設定|
|Terraformはstateロックでも守られ、Ansibleはパイプライン層でしか守られない（**[セクション5](#5-パイプライン層とツール層の二重の保護)**）|変わらない。Ansibleが操作対象に接続して設定を変える仕組みは、操作対象がコンテナでも仮想マシンでも同じ|

S3のバックエンドは、ロックを有効にしなければロックしません。`use_lockfile`を付け忘れると、tfstateはリモートにあって共有できても、ツール層の保護がない状態になります。リモートバックエンドに移すことと、ロックが効くことは、別に確かめる必要があります。

プロバイダーを切り替えて変わるのは、tfstateをどのサービスのどこに置き、どの認証情報で読み書きするかです。tfstateを作業ディレクトリの外の共有できる場所に置き、パイプライン層の直列化とツール層のstateロックの二重で守り、Ansibleにはツール層の保護がないことを前提に設計する、という構造は、プロバイダーを問わず同じです。

次のセクションでは、この回で確認した内容をまとめます。

---

[↑ 目次に戻る](#-目次)

---

## 7. まとめ

この回で整理した内容を確認します。

* self-hostedランナーの作業ディレクトリに置いたtfstateは、ジョブが終わっても残るが、次の実行のチェックアウトで削除されることを実機で確認した。`actions/checkout`の`clean`は既定で`git clean -ffdx`を実行し、`.gitignore`で除外したファイルも対象になる。tfstateがなくなると、Terraformは既存のリソースを把握できず、Ansibleの接続に使う鍵を含む10個のリソースをすべて新規作成として計画した
* tfstateの置き場所は、「消えないか」「ロックが効くか」「ランナーを増やしても共有できるか」の3つの基準で選ぶ。ローカルバックエンドも、作業ディレクトリの外に置けば消えず、OSの仕組みでロックするが、tfstateはそのホストにしかなく共有できない。差が出るのは3つ目の基準である
* tfstateを、PostgreSQLを使うpgバックエンドに`terraform init -migrate-state`で移し、移行の前後とも`terraform plan`が「No changes」であることを実機で確認した。接続情報は環境変数（`PG_CONN_STR`）で渡し、パイプラインには暫定的にGitHubのSecretsから渡した。ワークフローから`-state`の指定を外し、**[第5回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-05/)** から残していた非推奨の警告は出なくなった
* Ansibleのジョブは、インベントリと鍵を`terraform output`経由で用意しているため、tfstateの置き場所を変えても変更が及ばなかった。ホステッドランナーで動くワークフローは、上書きファイルでローカルバックエンドに切り替え、これまでどおりランナーの中で完結させた
* 同時実行は、連続したマージ、手元からの実行、ランナーの増設の3つの経路で起きる。重なったときに影響を受けるのは、tfstateと操作対象の2つである
* 手元の`terraform apply`がロックを持っている間、パイプラインの`terraform plan`は`Error acquiring the state lock`で止まることを実機で確認した。stateロックは、パイプラインの中と外の実行の間でも効く。この検証環境では、エラーの`Lock Info`は、ロックを持っている側ではなく、ロックを取ろうとした側の情報だった
* ワークフロー全体に`concurrency`を指定すると、パイプラインの実行は直列化された。ただし、既定では待機できる実行は1つだけで、待機中の実行は後から来た実行に置き換えられて取り消される。実際に、プルリクエストの確認の実行が取り消され、確認が一度も動かないままマージされたプルリクエストが出た。パスでジョブを切り替える構成では、マージの実行の取り消しは、その実行が判定するはずだった変更の取りこぼしにもつながるため、`queue: max`を指定した
* 同じ3台に対する2本のAnsibleは、互いを待たずに同時に動くことを実機で確認した。Terraformはパイプライン層の直列化とツール層のstateロックの二重で守られるが、Ansibleを守るのはパイプライン層の直列化だけで、パイプラインの外から実行するAnsibleは、どの層でも止められない
* AWSではS3（`use_lockfile = true`で有効にするロック）、GCPではGCSのバックエンドが、同じ役割を担う。置き換わるのはバックエンドの設定と認証情報で、作業ディレクトリにtfstateを置かないこと、二重の保護、Ansibleにはツール層の保護がないという構造は、プロバイダーを問わず同じである

---

[↑ 目次に戻る](#-目次)

---

## 8. 次回予告

本シリーズの **[第5回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-05/)** では、プルリクエストで確認し、マージで適用するパイプラインの骨格を組み、tfstateの置き場所は暫定の構成のまま残しました。第6回となる今回は、その暫定の部分を、置き場所と同時実行の2つの問題として設計しました。self-hostedランナーの作業ディレクトリに置いたtfstateが次の実行で削除されることを実機で確認し、置き場所を3つの基準で比較したうえで、pgバックエンドに移行しました。そのうえで、同時実行が起きる経路を整理し、Terraformのstateロックとパイプラインの直列化による二重の保護を実機で確かめ、Ansibleにはロックがないという非対称性を示しました。直列化の既定の動きでは、待機中の実行が取り消され、確認が一度も動かないままマージされたプルリクエストが出ることも確認しました。最後に、AWSやGCPでも、置き換わるのはバックエンドの設定と認証情報だけであることを整理しました。

この回で、適用系のジョブは、tfstateを失わず、重ならずに動くようになりました。一方、マージすれば適用されるという流れは、**[第5回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-05/)** から変わっていません。この回でも、プルリクエストの確認が動かないまま、マージと適用が進む場面がありました。

**[第7回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-07/)** では、この適用系のジョブの前に、planの結果をレビューして承認するゲートを設けます。レビューしたplanと実際に適用される内容のずれ、保存したplanの適用、`--check --diff`では承認者に見えない変更を扱い、無料プランの非公開リポジトリでも動く、手動起動による承認ゲートを設計します。

**[次回：第7回：planのレビューと承認ゲート](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-07/)**

---

📑 連載の移動　**[前の記事：【GitOps編】第5回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-05/)　｜　[次の記事：【GitOps編】第7回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-07/)**

---

> **🗺️ 初めての方、シリーズの全体像を知りたい方はこちら**
>
> シリーズ全体については、以下のまとめブログで整理しています。
>
> → **「Ansible×TerraformをGitOpsで回す」〜Terraformプロバイダーを問わない構成管理の自動化〜 第2部まとめブログ：GitOpsパイプラインで「見たものだけが、承認したときだけ届く」仕組みを積み上げる** **※近日公開予定**

---

[↑ 目次に戻る](#-目次)

---

## 9. 連載一覧：「Ansible×TerraformをGitOpsで回す」

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