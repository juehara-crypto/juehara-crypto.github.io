---
title: '「Ansible×TerraformをGitOpsで回す」〜Terraformプロバイダーを問わない構成管理の自動化〜 第4回：ローカルGitea vs GitHub Actionsの選択基準'
description: 'Gitリポジトリのホスティング先とパイプラインの実行場所の選択を、機能の比較ではなく、ランナーから操作対象に届くか、何を外部に預けるかという構造の問題として扱う。GitHubのホステッドランナー、self-hostedランナー、セルフホスト型Git基盤（Gitea）を、到達性、状態の永続性、機密情報の置き場所、運用負荷の4つの基準で比較し、選択が信頼の境界の要件で決まることを示す。本シリーズは、GitHubと、操作対象と同じネットワーク内に置くself-hostedランナーを採用し、リポジトリを非公開で運用する。'
pubDate: 2026-10-04
category: 'infra'
tags: ['Ansible', 'Terraform', 'GitOps', 'GitHub Actions', 'Gitea']
seriesId: 'ansible-gitops-part1'
seriesNo: 4
prevPost: 'https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part1/ansible-gitops-part1-03/'
nextPost: 'https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-05/'
relatedSeries: ''
---

<style> table th, table td { word-break: normal; } table td:first-child { white-space: nowrap; } </style>


> **🗺️ 初めての方、シリーズの全体像を知りたい方はこちら**
>
> シリーズ全体については、以下のまとめブログで整理しています。
>
> → **「Ansible×TerraformをGitOpsで回す」〜Terraformプロバイダーを問わない構成管理の自動化〜 第1部まとめブログ：「Gitが唯一の真実」を成り立たせる前提の設計** **※近日公開予定**

---

## 📋 目次

1. [はじめに](#1-はじめに)
2. [パイプラインはどこで実行されるのか](#2-パイプラインはどこで実行されるのか)
3. [到達性を確保する3つの構成](#3-到達性を確保する3つの構成)
4. [状態の永続性とドリフト観測](#4-状態の永続性とドリフト観測)
5. [セルフホスト型Git基盤でも同じワークフローは動くのか](#5-セルフホスト型git基盤でも同じワークフローは動くのか)
6. [4つの基準による比較と採用構成](#6-4つの基準による比較と採用構成)
7. [クラウドでも同じ判断が必要になる理由](#7-クラウドでも同じ判断が必要になる理由)
8. [まとめ](#8-まとめ)
9. [次回予告](#9-次回予告)
10. [連載一覧：「Ansible×TerraformをGitOpsで回す」](#10-連載一覧ansibleterraformをgitopsで回す)

---

## 1. はじめに

AnsibleとTerraformのコードをGitHubのリポジトリで管理していて、

* GitHub Actionsで、`terraform apply`と`ansible-playbook`を実行するワークフローを書いた
* ワークフローを起動すれば、管理しているサーバーに変更が反映される
* リポジトリのホスティング先やパイプラインの実行場所は、使い慣れたサービスを選べばよい

と考えていないでしょうか。

GitHub Actionsを扱う記事の多くは、GitHubが用意する実行環境（ホステッドランナー）の上でのビルドやテスト、あるいはクラウドの公開APIへのデプロイを題材にしています。プライベートなネットワークの中にあるサーバーをAnsibleで操作する場面は、あまり扱われていません。一方、AnsibleとTerraformのパイプラインを実際に組もうとすると、次のような場面にぶつかります。

* ワークフローは起動するのに、サーバーへのSSHの接続がタイムアウトする
* `terraform plan`は通るのに、Ansibleだけが失敗する
* ランナーの中で作ったコンテナでは検証が通るのに、実際のサーバーには届かない
* 定期実行でドリフトを検知しようとしたが、実行のたびに環境が作り直され、前回の実行からの変化を観測できない
* 社内の規定で、コードやジョブのログを外部のサービスに置けない

これらは、ネットワークの設定や社内の規定の問題に見えます。共通しているのは、パイプラインが動く場所から操作対象に届くか、そして何をどこに預けることになるかが、ホスティング先と実行場所を選ぶ時点で決まっていない点です。

パイプラインの実行場所は、「AnsibleとTerraformの連携が壊れる理由はライフサイクルにあった」（以下、Ansible×Terraformシリーズ）でも扱ってきました。Ansible×Terraformシリーズの **[第32回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part4/ansible-terraform-part4-32/)** と **[第37回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part4/ansible-terraform-part4-37/)** では、GitHub Actionsのワークフローで、Terraformによるコンテナの起動からAnsibleの適用、定期的なドリフトの検知までを実行しました。ただし、実行のたびに使い捨てられるホステッドランナーでは、常時起動しているインフラを外から監視できません。そのため、**[第37回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part4/ansible-terraform-part4-37/)** の定期検知は、コンテナの起動から改ざんの注入、検知までを、1回のワークフロー実行の中で完結させる構成でした。

本シリーズの **[第1回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part1/ansible-gitops-part1-01/)** のセクション5では、この構成を振り返ったうえで、管理対象と同じネットワーク内に置くself-hostedランナーを採用し、稼働し続けるインフラに対する定期検知と自動収束を第4部で作ると整理しました。**[第3回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part1/ansible-gitops-part1-03/)** では、変更の分類をパスで表現するリポジトリの構造と、mainを唯一の真実とするブランチ運用を設計しました。同じ回で、リポジトリを非公開で運用することを前提にしましたが、その理由はまだ示していません。

この回では、**[第3回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part1/ansible-gitops-part1-03/)** で設計したリポジトリを、どこでホストし、パイプラインをどこで動かすかを決めます。比較するのは、GitHubのホステッドランナー、GitHubのself-hostedランナー、そしてセルフホスト型のGit基盤とそのCIの3つの構成です。セルフホスト型のGit基盤は、Giteaを代表例として検証します。これらを、到達性、状態の永続性、機密情報の置き場所、運用負荷の4つの基準で比較し、本シリーズの採用構成と、リポジトリを非公開で運用する理由を示します。第1部の最終回として、第2部（**[第5回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-05/)** 〜 **[第12回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-12/)**）でパイプラインを組むための実行基盤を、この回で確定させます。

正確に言うと、**パイプラインをどこに置くかは、機能の比較では決まらず、ランナーから操作対象に届くかと、何を外部に預けるかという信頼の境界で決まります**。この回で扱う問いは、「パイプラインをどこで動かせば操作対象に届き、何をどこまで外部に預けることになるのか」です。

次のセクションでは、パイプラインが実際にどこで実行されているのかを確認します。

---

[↑ 目次に戻る](#-目次)

---

## 2. パイプラインはどこで実行されるのか

GitHub Actionsのジョブが実際にどこで実行され、そこから操作対象に届くかを確認します。

### パイプラインが成立する条件

パイプラインでAnsibleとTerraformを実行するには、ジョブを実行する環境（ランナー）から、それぞれのツールの接続先に届く必要があります。

* Terraform：プロバイダーのAPIに接続する。DockerプロバイダーであればDockerデーモン、AWSやGCPであればクラウドのAPIが接続先になる
* Ansible：インベントリに書かれた接続先へ、SSHで接続する

どちらか一方でも届かなければ、パイプラインは成立しません。ここでは、Ansibleの接続先であるSSHのポートに届くかを確認します。Terraformの接続先に届くかはプロバイダーによって異なるため、**[セクション7](#7-クラウドでも同じ判断が必要になる理由)** で扱います。

GitHubの公式ドキュメント（**[GitHub-hosted runners](https://docs.github.com/en/actions/concepts/runners/github-hosted-runners)**）では、GitHubが用意するランナー（ホステッドランナー）は、一部を除き、ジョブごとに新しく用意される仮想マシンであり、LinuxのランナーはMicrosoft Azureの仮想マシン上で動くとされています。一方、操作対象は、オンプレミスのサーバーやクラウドのプライベートサブネット内のインスタンスのように、プライベートなネットワークの中にあることが一般的です。

```
【GitHubが用意するネットワーク】
　ホステッドランナー（ジョブごとに用意される仮想マシン）
　　│
　　│　SSH（Ansible）
　　↓
【プライベートなネットワーク】
　操作対象（オンプレミスのサーバー、プライベートサブネット内のインスタンスなど）
```

この検証環境では、操作対象のコンテナ（target-node1〜3）は、1台のLinuxホストの上で、Dockerのプライベートなネットワークに接続しています。

### ■ 検証内容：ホステッドランナーから操作対象への接続

接続を確認するためのワークフローを、リポジトリに追加します。

* **ファイル名：`.github/workflows/reachability-check.yml`**

```yaml
name: reachability-check

on:
  workflow_dispatch:
    inputs:
      runner:
        description: 'runs-onに渡すランナーのラベル'
        required: true
        default: 'ubuntu-latest'
        type: choice
        options:
          - ubuntu-latest
          - self-hosted
      target_host:
        description: '接続先のIPアドレス'
        required: true
        type: string

jobs:
  check:
    runs-on: ${{ inputs.runner }}
    steps:
      - name: 実行環境を表示する
        run: |
          echo "hostname=$(hostname)"
          echo "runner_environment=${RUNNER_ENVIRONMENT}"
          ip -4 -o addr show scope global
      - name: 接続先のSSHポートに接続する
        env:
          TARGET_HOST: ${{ inputs.target_host }}
        run: |
          nc -zv -w 5 "${TARGET_HOST}" 22 && rc=0 || rc=$?
          echo "exit_code=${rc}"
```

このワークフローは、手動で起動したときだけ実行されます（`workflow_dispatch`）。起動するときに、どのランナーで実行するか（`runner`）と、接続先のIPアドレス（`target_host`）を入力します。接続先のIPアドレスをファイルに書かず、起動時に渡すのは、**[第2回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part1/ansible-gitops-part1-02/)** のセクション4で確認したとおり、IPアドレスはGitの外にある値だからです。

ジョブの1つ目のステップでは、ランナーのホスト名、ランナーの種別、IPアドレスを表示します。ランナーの種別を示す`RUNNER_ENVIRONMENT`は、GitHubが設定する環境変数で、ホステッドランナーでは`github-hosted`、self-hostedランナーでは`self-hosted`になります（**[Variables reference](https://docs.github.com/en/actions/reference/workflows-and-actions/variables)**）。2つ目のステップでは、接続先のSSHのポート（22番）に`nc`で接続し、終了コードを表示します。

接続先には、target-node1のIPアドレスを使います。

**実行コマンド**

```plaintext
terraform output target_nodes_ips
```

**▼ 実行結果**

```plaintext
{
  "target-node1" = "172.19.0.4"
  "target-node2" = "172.19.0.2"
  "target-node3" = "172.19.0.3"
}
```

GitHubのリポジトリの「Actions」タブからこのワークフローを手動で起動し、`runner`に`ubuntu-latest`、`target_host`に`172.19.0.4`を入力して実行しました。ジョブのログは次のとおりです。ログの各行の先頭にある時刻は省略しています。

まず、ジョブの準備（Set up job）のログには、ランナーを用意した基盤が表示されています。

**▼ 実行結果（Set up jobから抜粋）**

```plaintext
##[group]Runner Image Provisioner
Hosted Compute Agent
（途中省略：バージョン、コミット、ビルド日時、ワーカーIDの表示）
Azure Region: eastus
##[endgroup]
```

**▼ 実行結果（ステップ「実行環境を表示する」）**

```plaintext
##[group]Run echo "hostname=$(hostname)"
（途中省略：実行したスクリプトとシェルの表示）
##[endgroup]
hostname=runnervm8df0l
runner_environment=github-hosted
2: eth0    inet 10.1.0.5/20 metric 100 brd 10.1.15.255 scope global eth0\       valid_lft forever preferred_lft forever
4: docker0    inet 172.17.0.1/16 brd 172.17.255.255 scope global docker0\       valid_lft forever preferred_lft forever
```

**▼ 実行結果（ステップ「接続先のSSHポートに接続する」）**

```plaintext
##[group]Run nc -zv -w 5 "${TARGET_HOST}" 22 && rc=0 || rc=$?
（途中省略：実行したスクリプト、シェル、環境変数の表示）
##[endgroup]
nc: connect to 172.19.0.4 port 22 (tcp) timed out: Operation now in progress
exit_code=1
```

接続は5秒でタイムアウトしました。このタイムアウトが、target-node1が停止していたためではないことを確かめるため、操作対象と同じホストから、同じ接続先に同じコマンドで接続します。

**実行コマンド**

```plaintext
docker ps --format 'table {{.Names}}\t{{.Status}}'
```

**▼ 実行結果**

```plaintext
NAMES          STATUS
target-node1   Up About an hour
target-node2   Up About an hour
target-node3   Up About an hour
```

**実行コマンド**

```plaintext
nc -zv -w 5 172.19.0.4 22; echo "exit_code=$?"
```

**▼ 実行結果**

```plaintext
Connection to 172.19.0.4 22 port [tcp/ssh] succeeded!
exit_code=0
```

### ■ 結果

同じ接続先（`172.19.0.4`のポート22）に対する2つの結果を並べると、次のとおりです。

|接続元|接続元のネットワーク|結果|
|---|---|---|
|ホステッドランナー|`10.1.0.5/20`（`eth0`）|タイムアウト（`exit_code=1`）|
|操作対象と同じホスト|操作対象と同じDockerのネットワークにつながるホスト|接続成功（`exit_code=0`）|

target-node1は起動していて、SSHのポートで待ち受けています。結果を分けたのは、接続先の状態ではなく、接続元がどこにあるかです。ホステッドランナーは、Azureの仮想マシン（`Azure Region: eastus`）として、`10.1.0.5/20`という、GitHubが用意したネットワークの中で動いていて、操作対象のネットワークへの経路を持っていません。

ホステッドランナーには、ランナー自身のDockerのネットワーク（`docker0`、`172.17.0.1/16`）もありました。プライベートなIPアドレスは、ネットワークごとに同じ範囲が繰り返し使われます。`172.19.0.4`という値は、この検証環境のホストの中のネットワークでだけ意味を持つアドレスであり、別のネットワークにあるランナーからは、同じ形のアドレスでも同じ相手を指しません。

この構造は、操作対象がオンプレミスのサーバーでも、クラウドのプライベートサブネット内のインスタンスでも同じです。プライベートなネットワークの中にある操作対象には、ホステッドランナーから直接SSHで届きません。**[セクション1](#1-はじめに)** で挙げた「ワークフローは起動するのに、サーバーへのSSHの接続がタイムアウトする」という場面は、この状態です。

次のセクションでは、ランナーから操作対象に届くようにするための3つの構成を整理します。

---

[↑ 目次に戻る](#-目次)

---

## 3. 到達性を確保する3つの構成

ランナーから操作対象に届くようにする構成を3つに整理し、そのうち、操作対象と同じネットワークにself-hostedランナーを置く構成を実機で確認します。

### 3つの構成

**[セクション2](#2-パイプラインはどこで実行されるのか)** で確認したとおり、ホステッドランナーからは、プライベートなネットワークの中にある操作対象に届きません。ランナーから操作対象に届くようにするには、ランナーと操作対象を同じネットワークに置く必要があります。その置き方には、次の3つがあります。

```
【構成1：ランナーの中で環境ごと作る】
GitHub　→　ホステッドランナー
　　　　　　　└─ 操作対象（実行のたびに、ランナーの中に作る）

【構成2：操作対象と同じネットワークに、self-hostedランナーを置く】
GitHub　←　（外向きのHTTPSでジョブを取りに行く）　self-hostedランナー
　　　　　　　　　　　　　　　　　　　　　　　　　　　　　│　SSH
　　　　　　　　　　　　　　　　　　　　　　　　　　　　　↓
　　　　　　　　　　　　　　　　　　　　　　　　　　　操作対象
　　　　　　　　　　　　　　　　　　　　　（ここまでがプライベートなネットワーク）

【構成3：操作対象と同じネットワークに、Git基盤とCIのランナーを置く】
Git基盤（Gitea、GitLabなど）　→　CIのランナー　→（SSH）→　操作対象
（すべてプライベートなネットワーク）
```

構成1は、操作対象をランナーの中に作ることで、ランナーと操作対象を同じ場所に置く構成です。Ansible×Terraformシリーズの **[第32回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part4/ansible-terraform-part4-32/)** と **[第37回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part4/ansible-terraform-part4-37/)** で、コンテナの起動からAnsibleの適用までを1回のワークフロー実行の中で行ったのが、この構成です。届くことは保証されますが、操作対象はランナーとともに実行のたびに作り直されます。この点は、**[セクション4](#4-状態の永続性とドリフト観測)** で扱います。

構成2は、GitHubはそのまま使い、ジョブを実行するランナーだけを、操作対象と同じネットワークに置く構成です。GitHubの公式ドキュメント（**[Self-hosted runners reference](https://docs.github.com/en/actions/reference/runners/self-hosted-runners)**）では、self-hostedランナーは、GitHubに接続してジョブの割り当てを受け取るとされています。通信の要件として挙げられているのは、ランナーを置くホストから外向きにHTTPS（443番）で接続できることで、外からランナーに接続するためにポートを開ける要件は挙げられていません。

構成3は、Gitのリポジトリそのものと、CIのランナーの両方を、操作対象と同じネットワークに置く構成です。この構成は、**[セクション5](#5-セルフホスト型git基盤でも同じワークフローは動くのか)** で、Giteaを代表例として確認します。

ここでは、構成2を実機で確認します。

### ■ 検証内容：self-hostedランナーの登録

この検証環境では、操作対象のコンテナが動いているLinuxホストに、self-hostedランナーを置きます。GitHubのリポジトリの「Settings」→「Actions」→「Runners」で「New self-hosted runner」を開くと、OSとアーキテクチャ（ここではLinux、x64）に応じた、ダウンロードと登録のコマンドが表示されます。表示されたコマンドを、ホームディレクトリの下で実行しました。登録の対話形式の質問には、すべて既定値で答えています。ランナーは、サービスとして登録して起動しました。`shasum`の行は、ダウンロードしたファイルのハッシュ値を、画面に表示された値と照合する確認です。

**実行コマンド**

```plaintext
mkdir actions-runner && cd actions-runner
curl -o actions-runner-linux-x64-2.337.0.tar.gz -L https://github.com/actions/runner/releases/download/v2.337.0/actions-runner-linux-x64-2.337.0.tar.gz
echo "70920811a4f8ad4328818682bca5c6469c1c942fab52448868071d0063816613  actions-runner-linux-x64-2.337.0.tar.gz" | shasum -a 256 -c
tar xzf ./actions-runner-linux-x64-2.337.0.tar.gz
./config.sh --url https://github.com/juehara-crypto/ansible-terraform-ci-lab --token （画面に表示された登録用のトークン）
sudo ./svc.sh install control
sudo ./svc.sh start
```

サービスの状態を確認します。

**実行コマンド**

```plaintext
systemctl is-enabled actions.runner.juehara-crypto-ansible-terraform-ci-lab.ubuntu-controller.service
systemctl is-active actions.runner.juehara-crypto-ansible-terraform-ci-lab.ubuntu-controller.service
```

**▼ 実行結果**

```plaintext
enabled
active
```

ランナーはサービスとして起動していて（`active`）、ホストを再起動しても自動で起動する設定（`enabled`）になっています。

GitHubのリポジトリのランナーの一覧には、登録したランナー`ubuntu-controller`が、ラベル`self-hosted`、`Linux`、`X64`とともに表示され、状態はジョブを待っている「Idle」になりました。

![リポジトリに登録したself-hostedランナーの一覧（ubuntu-controller、ラベルself-hosted・Linux・X64、状態Idle）](/images/blog/infra/ansible/ansible-gitops/ansible-gitops-part1/ansible-gitops-part1-04/section3-runner-idle.png)

### ■ 検証内容：self-hostedランナーから操作対象への接続

**[セクション2](#2-パイプラインはどこで実行されるのか)** と同じワークフローを、`runner`に`self-hosted`、`target_host`に`172.19.0.4`を入力して起動しました。変えたのは、ジョブを実行するランナーの指定だけです。ジョブのログは次のとおりです。ログの各行の先頭にある時刻は省略しています。

**▼ 実行結果（Set up jobから抜粋）**

```plaintext
Current runner version: '2.337.0'
Runner name: 'ubuntu-controller'
Runner group name: 'Default'
Machine name: 'ubuntu-controller'
```

**▼ 実行結果（ステップ「実行環境を表示する」）**

```plaintext
##[group]Run echo "hostname=$(hostname)"
（途中省略：実行したスクリプトとシェルの表示）
##[endgroup]
hostname=ubuntu-controller
runner_environment=self-hosted
2: enp0s8    inet 192.168.56.30/24 brd 192.168.56.255 scope global enp0s8\       valid_lft forever preferred_lft forever
3: enp0s9    inet 10.0.4.15/24 metric 100 brd 10.0.4.255 scope global dynamic enp0s9\       valid_lft 78854sec preferred_lft 78854sec
4: br-241cceaae174    inet 172.18.0.1/16 brd 172.18.255.255 scope global br-241cceaae174\       valid_lft forever preferred_lft forever
5: br-3ab348052bbc    inet 172.19.0.1/16 brd 172.19.255.255 scope global br-3ab348052bbc\       valid_lft forever preferred_lft forever
6: docker0    inet 172.17.0.1/16 brd 172.17.255.255 scope global docker0\       valid_lft forever preferred_lft forever
```

**▼ 実行結果（ステップ「接続先のSSHポートに接続する」）**

```plaintext
##[group]Run nc -zv -w 5 "${TARGET_HOST}" 22 && rc=0 || rc=$?
（途中省略：実行したスクリプト、シェル、環境変数の表示）
##[endgroup]
exit_code=0
Connection to 172.19.0.4 22 port [tcp/ssh] succeeded!
```

`br-3ab348052bbc`がどのネットワークかを確認します。

**実行コマンド**

```plaintext
docker network ls --filter name=ansible-lab-net
```

**▼ 実行結果**

```plaintext
NETWORK ID     NAME              DRIVER    SCOPE
3ab348052bbc   ansible-lab-net   bridge    local
```

### ■ 結果

同じワークフローを、ランナーの指定だけを変えて実行した結果を並べると、次のとおりです。

|ランナー|`runner_environment`|操作対象のネットワークとのつながり|`172.19.0.4`のポート22への接続|
|---|---|---|---|
|ホステッドランナー（**[セクション2](#2-パイプラインはどこで実行されるのか)**）|`github-hosted`|なし（`10.1.0.5/20`）|タイムアウト（`exit_code=1`）|
|self-hostedランナー|`self-hosted`|あり（`br-3ab348052bbc`、`172.19.0.1/16`）|接続成功（`exit_code=0`）|

self-hostedランナーは、操作対象と同じホストで動き、操作対象がつながっている`ansible-lab-net`（`3ab348052bbc`）に、ランナー自身もつながっています。ジョブは、GitHubから受け取った後、このネットワークの中で実行されるため、操作対象に届きました。

この検証で、ランナーのためにホストの受信のポートは開けていません。ランナーの側からGitHubに接続してジョブを受け取る形なので、操作対象のネットワークの外から、ネットワークの中に入ってくる接続は発生しません。ワークフローの記述も、`runs-on`に渡すラベルを変えただけで、ジョブの中身は同じです。

このself-hostedランナーは、第2部以降のパイプラインでもそのまま使います。

次のセクションでは、構成1と構成2の違いを、操作対象の状態が実行をまたいで残るかという観点で整理します。

---

[↑ 目次に戻る](#-目次)

---

## 4. 状態の永続性とドリフト観測

**[セクション3](#3-到達性を確保する3つの構成)** の構成1と構成2の違いを、操作対象の状態が実行をまたいで残るかという観点で整理し、構成2で実際に観測できることを確認します。

### 構成1では、前回の実行以降のずれを観測できない

構成1では、操作対象をランナーの中に作ります。**[セクション2](#2-パイプラインはどこで実行されるのか)** で引用した公式ドキュメントのとおり、ホステッドランナーはジョブごとに新しく用意される仮想マシンなので、その中に作った操作対象も、実行が終わるとランナーとともになくなります。次の実行では、コードから操作対象を作り直すところから始まります。

このため、構成1では、「前回の実行の後に、操作対象に何が起きたか」を観測できません。前回の実行の後に手動変更があったとしても、その変更が加えられた操作対象は、次の実行の時点ではもう存在しないからです。Ansible×Terraformシリーズの **[第37回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part4/ansible-terraform-part4-37/)** の定期検知が、コンテナの起動から改ざんの注入、検知までを1回のワークフロー実行の中で完結させる構成だったのは、このためです。

また、構成1で検証しているのは、ランナーの中に作った操作対象であり、実際に運用している操作対象ではありません。**[セクション1](#1-はじめに)** で挙げた「ランナーの中で作ったコンテナでは検証が通るのに、実際のサーバーには届かない」という場面は、この違いから生まれます。

一方、構成2では、操作対象はランナーとは別に存在し続け、ランナーは実行のたびに、同じ操作対象に接続します。この違いを、実機で確認します。

### ■ 検証内容：実行をまたいだ操作対象の観測

操作対象の状態を読むだけのワークフローを、リポジトリに追加します。

* **ファイル名：`.github/workflows/state-check.yml`**

```yaml
name: state-check

on:
  workflow_dispatch:

jobs:
  check:
    runs-on: self-hosted
    steps:
      - name: 操作対象のコンテナを表示する
        run: |
          docker inspect --format '{{.Name}} id={{.Id}} created={{.Created}}' target-node1
      - name: 操作対象の設定ファイルを表示する
        run: |
          docker exec target-node1 cat /etc/drift-check-target.conf
```

1つ目のステップでは、target-node1のコンテナのIDと作成日時を表示します。2回の実行で同じコンテナを見ているかを、IDで確かめるためです。2つ目のステップでは、Playbookが配置している`/etc/drift-check-target.conf`の内容を表示します。ジョブは、**[セクション3](#3-到達性を確保する3つの構成)** で登録したself-hostedランナーで実行します。

このワークフローを手動で起動しました（1回目）。ジョブのログは次のとおりです。ログの各行の先頭にある時刻は省略しています。

**▼ 実行結果（1回目、ステップ「操作対象のコンテナを表示する」）**

```plaintext
##[group]Run docker inspect --format '{{.Name}} id={{.Id}} created={{.Created}}' target-node1
（途中省略：実行したスクリプトとシェルの表示）
##[endgroup]
/target-node1 id=661068c035d5f431a2752a43545c6afeaf648efbde79933925a34c1bf531325d created=2026-10-04T00:55:00.51973054Z
```

**▼ 実行結果（1回目、ステップ「操作対象の設定ファイルを表示する」）**

```plaintext
##[group]Run docker exec target-node1 cat /etc/drift-check-target.conf
（途中省略：実行したスクリプトとシェルの表示）
##[endgroup]
monitored_by=ansible-drift-check
```

1回目の実行の後に、パイプラインを通さずに、target-node1のファイルを書き換えます。**[第1回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part1/ansible-gitops-part1-01/)** のセクション6と同じ方法です。

**実行コマンド**

```plaintext
docker exec -it target-node1 bash -c "sed -i 's/ansible-drift-check/manual-edit/' /etc/drift-check-target.conf"
```

**▼ 実行結果**

```plaintext
（出力なし）
```

**実行コマンド**

```plaintext
docker exec -it target-node1 bash -c "cat /etc/drift-check-target.conf"
```

**▼ 実行結果**

```plaintext
monitored_by=manual-edit
```

この状態で、同じワークフローをもう一度起動しました（2回目）。

**▼ 実行結果（2回目、ステップ「操作対象のコンテナを表示する」）**

```plaintext
##[group]Run docker inspect --format '{{.Name}} id={{.Id}} created={{.Created}}' target-node1
（途中省略：実行したスクリプトとシェルの表示）
##[endgroup]
/target-node1 id=661068c035d5f431a2752a43545c6afeaf648efbde79933925a34c1bf531325d created=2026-10-04T00:55:00.51973054Z
```

**▼ 実行結果（2回目、ステップ「操作対象の設定ファイルを表示する」）**

```plaintext
##[group]Run docker exec target-node1 cat /etc/drift-check-target.conf
（途中省略：実行したスクリプトとシェルの表示）
##[endgroup]
monitored_by=manual-edit
```

### ■ 結果

2回の実行の結果を並べると、次のとおりです。

|実行|コンテナのID（先頭12文字）|作成日時|`/etc/drift-check-target.conf`|
|---|---|---|---|
|1回目|`661068c035d5`|`2026-10-04T00:55:00.51973054Z`|`monitored_by=ansible-drift-check`|
|2回目|`661068c035d5`|`2026-10-04T00:55:00.51973054Z`|`monitored_by=manual-edit`|

2回の実行で、コンテナのIDと作成日時は同じでした。ランナーは2回とも同じ操作対象に接続していて、操作対象は実行と実行の間も存在し続けています。そのため、1回目の実行の後にパイプラインの外で加えた書き換えを、2回目の実行で観測できました。

これが、構成1との違いです。構成1では、2回目の実行の時点で、1回目に作った操作対象はもう存在しないため、その間に起きた書き換えを観測する対象がありません。

本シリーズの第4部（**[第17回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part4/ansible-gitops-part4-17/)** 〜 **[第21回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part4/ansible-gitops-part4-21/)**）で作る定期的なドリフトの検知と自動収束は、「前回の実行以降に、操作対象がGitの内容からずれたか」を見る仕組みです。この仕組みが成り立つには、操作対象が実行をまたいで存在し続け、ランナーが毎回その操作対象に届く必要があります。この条件を満たすのは、構成2と構成3です。ここでは状態を表示しただけですが、ずれを検知する手段（`ansible-playbook --check`の定期実行など）は、**[第18回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part4/ansible-gitops-part4-18/)** で扱います。

最後に、書き換えたファイルを、Playbookの本実行で元に戻します。

**実行コマンド**

```plaintext
ansible-playbook -i inventory.ini site.yml
```

**▼ 実行結果**

```plaintext
（途中省略：PLAYとTASKの表示、Pythonのインタープリターに関する警告）
PLAY RECAP ***********************************************************************************************************************
target-node1               : ok=2    changed=1    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
target-node2               : ok=2    changed=0    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
target-node3               : ok=2    changed=0    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
```

**実行コマンド**

```plaintext
docker exec -it target-node1 bash -c "cat /etc/drift-check-target.conf"
```

**▼ 実行結果**

```plaintext
monitored_by=ansible-drift-check
```

target-node1だけが`changed=1`となり、ファイルの内容が`monitored_by=ansible-drift-check`に戻りました。

次のセクションでは、構成3として、セルフホスト型のGit基盤とそのCIでも、同じワークフローが動くかを確認します。

---

[↑ 目次に戻る](#-目次)

---

## 5. セルフホスト型Git基盤でも同じワークフローは動くのか

**[セクション3](#3-到達性を確保する3つの構成)** の構成3として、Gitのリポジトリとそのランナーを、操作対象と同じネットワークに置く構成を確認します。セルフホスト型のGit基盤には、GitLabなどいくつかの選択肢がありますが、ここではGiteaとそのCIの機能（Gitea Actions）を代表例として取り上げます。確認したいのは、**[セクション2](#2-パイプラインはどこで実行されるのか)** と **[セクション3](#3-到達性を確保する3つの構成)** で使ったワークフローが、そのまま動くか、そして操作対象に届くかです。

GiteaとGitea Actionsのランナーは、どちらもDockerコンテナとして起動します。そのため、Dockerが動くLinuxホストであれば、物理サーバーでも、仮想マシンでも、クラウドのインスタンスでも、同じ手順で再現できます。ここでは、操作対象が動いているのと同じLinuxホストで起動します。構築は最小限にとどめ、インストール手順の詳しい解説はしません。

### ■ 検証内容：GiteaとGitea Actionsのランナーの起動

Giteaを起動します。初期設定の画面を省く設定（`INSTALL_LOCK`）と、プッシュでリポジトリを作れる設定を付けています。プッシュで作ったリポジトリは非公開になります。

**実行コマンド**

```plaintext
docker volume create gitops04-gitea-data
docker run -d --name gitops04-gitea \
  -p 3000:3000 \
  -e USER_UID=1000 \
  -e USER_GID=1000 \
  -e GITEA__security__INSTALL_LOCK=true \
  -e GITEA__server__ROOT_URL=http://192.168.56.30:3000/ \
  -e GITEA__repository__ENABLE_PUSH_CREATE_USER=true \
  -e GITEA__repository__DEFAULT_PUSH_CREATE_PRIVATE=true \
  -v gitops04-gitea-data:/data \
  docker.gitea.com/gitea:28.0.0
sleep 15
docker ps --filter name=gitops04-gitea --format '{{.Names}}\t{{.Status}}\t{{.Ports}}'
```

**▼ 実行結果**

```plaintext
gitops04-gitea-data
（途中省略：イメージのダウンロードの表示）
1955fcff422156de5d0d7e8226053a6f0c0b4b9614d965f10b828c6dc3b4acd8
gitops04-gitea  Up 16 seconds   22/tcp, 0.0.0.0:3000->3000/tcp, [::]:3000->3000/tcp
```

**実行コマンド**

```plaintext
curl -sI http://localhost:3000 | head -1
```

**▼ 実行結果**

```plaintext
HTTP/1.1 200 OK
```

管理者のユーザーを作成します。パスワードは、`--random-password`で生成しました。

**実行コマンド**

```plaintext
docker exec -u git gitops04-gitea gitea admin user create \
  --username gitops \
  --email gitops@example.com \
  --admin \
  --random-password \
  --must-change-password=false
```

**▼ 実行結果**

```plaintext
（途中省略：生成されたパスワードの表示）
New user 'gitops' has been successfully created!
```

次に、**[セクション2](#2-パイプラインはどこで実行されるのか)** で作った`reachability-check.yml`を、中身を変えずにコピーしたリポジトリを作ります。

**実行コマンド**

```plaintext
mkdir /tmp/gitops04-gitea && cd /tmp/gitops04-gitea
git init -q -b main
mkdir -p .github/workflows
cp ~/iac/docker-lab-ci/.github/workflows/reachability-check.yml .github/workflows/
git add .github/workflows/reachability-check.yml
git -c user.name=gitops -c user.email=gitops@example.com commit -q -m "接続確認用のワークフロー"
```

コピー元とコピー先のファイルが同じであることを、ハッシュ値で確認します。

**実行コマンド**

```plaintext
sha256sum ~/iac/docker-lab-ci/.github/workflows/reachability-check.yml /tmp/gitops04-gitea/.github/workflows/reachability-check.yml
```

**▼ 実行結果**

```plaintext
d3febcde79ab5a8d01383ac093a6a2188d7a87451e15e391a9be6f468eb5c869  /home/control/iac/docker-lab-ci/.github/workflows/reachability-check.yml
d3febcde79ab5a8d01383ac093a6a2188d7a87451e15e391a9be6f468eb5c869  /tmp/gitops04-gitea/.github/workflows/reachability-check.yml
```

Giteaにプッシュします。`-c credential.helper=`は、このプッシュでだけ、認証情報を保存しないための指定です。

**実行コマンド**

```plaintext
git -c credential.helper= push http://192.168.56.30:3000/gitops/gitops04-reachability.git main; echo "exit_code=$?"
```

**▼ 実行結果**

```plaintext
Username for 'http://192.168.56.30:3000': gitops
Password for 'http://gitops@192.168.56.30:3000':
Enumerating objects: 5, done.
Counting objects: 100% (5/5), done.
Delta compression using up to 2 threads
Compressing objects: 100% (3/3), done.
Writing objects: 100% (5/5), 829 bytes | 207.00 KiB/s, done.
Total 5 (delta 0), reused 0 (delta 0), pack-reused 0
To http://192.168.56.30:3000/gitops/gitops04-reachability.git
 * [new branch]      main -> main
exit_code=0
```

最後に、ランナーを起動します。登録用のトークンはGiteaのコマンドで発行し、画面に表示せずにランナーに渡しています。ランナーは、ホストのDockerを使ってジョブのコンテナを作るため、`/var/run/docker.sock`を渡します（**[Install with Docker](https://docs.gitea.com/runner/installation/docker/)**）。ラベルは指定せず、既定のままにしました。

**実行コマンド**

```plaintext
GITEA_RUNNER_TOKEN=$(docker exec -u git gitops04-gitea gitea actions generate-runner-token)
docker volume create gitops04-runner-data
docker run -d --name gitops04-runner \
  -e GITEA_INSTANCE_URL=http://192.168.56.30:3000/ \
  -e GITEA_RUNNER_REGISTRATION_TOKEN="$GITEA_RUNNER_TOKEN" \
  -e GITEA_RUNNER_NAME=gitops04-runner \
  -v gitops04-runner-data:/data \
  -v /var/run/docker.sock:/var/run/docker.sock \
  docker.io/gitea/runner:3
unset GITEA_RUNNER_TOKEN
sleep 15
docker ps --filter name=gitops04 --format '{{.Names}}\t{{.Status}}'
docker logs gitops04-runner 2>&1 | tail -20
```

**▼ 実行結果**

```plaintext
gitops04-runner-data
（途中省略：イメージのダウンロードの表示）
9093e59f8eca11ccafb27d37aebf8c35196b4f89a70bbfc485be3664341dfecd
gitops04-runner Up 15 seconds
gitops04-gitea  Up 23 minutes
.runner is missing or not a regular file
level=info msg="Registering runner, arch=amd64, os=linux, version=v3.5.0."
level=debug msg="Successfully pinged the Gitea instance server"
level=info msg="Runner registered successfully."
SUCCESS
time="2026-10-04T05:14:39Z" level=info msg="Starting runner daemon"
time="2026-10-04T05:14:39Z" level=info msg="runner: gitops04-runner, with version: v3.5.0, with labels: [ubuntu-latest ubuntu-24.04 ubuntu-22.04], declare successfully"
```

ランナーは登録され、`ubuntu-latest`、`ubuntu-24.04`、`ubuntu-22.04`の3つのラベルでジョブを待つ状態になりました。

### ■ 検証内容：同じワークフローの実行

Giteaの画面でリポジトリの「Actions」を開くと、プッシュしたワークフロー`reachability-check`が一覧に表示され、手動で実行できることを示す「このワークフローには workflow_dispatch イベントトリガーがあります。」という表示が出ました。「ワークフローを実行」を押すと、ブランチの選択と、ワークフローに書いた2つの入力（ランナーのラベルの選択肢と、接続先のIPアドレスの入力欄）が、GitHubと同じ形で表示されました。

![Giteaのワークフローの手動実行の入力画面（ブランチmain、ランナーのラベルの選択肢、接続先のIPアドレスの入力欄）](/images/blog/infra/ansible/ansible-gitops/ansible-gitops-part1/ansible-gitops-part1-04/section5-gitea-dispatch-form.png)

**1回目：`runner`に`self-hosted`を指定する**

**[セクション3](#3-到達性を確保する3つの構成)** と同じく、`runner`に`self-hosted`、`target_host`に`172.19.0.4`を入力して実行しました。ジョブは「待機中」のまま進まず、ジョブの画面には「ラベルに一致するオンラインのランナーが見つかりません: self-hosted」と表示されました。Giteaのランナーのラベルに`self-hosted`がないためです。この実行はキャンセルしました。

![Giteaのジョブの画面（ジョブcheckが待機中で、「ラベルに一致するオンラインのランナーが見つかりません: self-hosted」と表示）](/images/blog/infra/ansible/ansible-gitops/ansible-gitops-part1/ansible-gitops-part1-04/section5-gitea-no-runner.png)

**2回目：`runner`に`ubuntu-latest`を指定する**

ランナーが持つラベル`ubuntu-latest`を指定して、もう一度実行しました。ジョブのログは次のとおりです。ログの各行の先頭にある時刻は省略しています。

**▼ 実行結果（2回目、ジョブのコンテナの起動）**

```plaintext
::group::Starting job container
image: docker.gitea.com/runner-images:ubuntu-latest
name: GITEA-ACTIONS-TASK-1-WORKFLOW-reachability-check-JOB-check-chec-7abdb9b842675d7ba9ab4cf730e8e22f12273422bd70f319e4dd006ea5cd33bf
network: GITEA-ACTIONS-TASK-1-WORKFLOW-reachability-check-JOB-check-chec-7abdb9b842675d7ba9ab4cf730e8e22f12273422bd70f319e4dd006ea5cd33bf-check-network
（途中省略：イメージのダウンロードとコンテナの作成の表示）
::endgroup::
```

**▼ 実行結果（2回目、ステップ「実行環境を表示する」）**

```plaintext
::group::Run echo "hostname=$(hostname)"
（途中省略：実行したスクリプトとシェルの表示）
::endgroup::
hostname=e51090574d44
runner_environment=self-hosted
/var/run/act/workflow/0.sh: line 4: ip: command not found
##[error]Process completed with exit code 127.
```

ジョブは、ランナーが作ったコンテナ（`docker.gitea.com/runner-images:ubuntu-latest`）の中で、ジョブ専用のネットワークにつながれて実行されました。ところが、このイメージには`ip`コマンドが含まれていなかったため、1つ目のステップで失敗し、接続を確認する2つ目のステップは実行されませんでした。

**3回目：ジョブのコンテナのイメージに、必要なツールを加える**

ワークフローは変えずに、ランナーの側で、ジョブを実行するイメージを替えます。Giteaの公式ドキュメント（**[Labels](https://docs.gitea.com/runner/labels/)**）では、ラベルは、どのジョブを受け付け、どのイメージで実行するかを決めるもので、ワークフローが使うツールを含むイメージを選ぶよう案内されています。既定のイメージに`ip`と`nc`を加えたイメージを作ります。

* **ファイル名：`/tmp/gitops04-image/Dockerfile`**

```dockerfile
FROM docker.gitea.com/runner-images:ubuntu-latest
RUN apt-get update \
 && apt-get install -y --no-install-recommends iproute2 netcat-openbsd \
 && rm -rf /var/lib/apt/lists/*
```

**実行コマンド**

```plaintext
docker build -t gitops04-runner-image:latest .
docker run --rm gitops04-runner-image:latest sh -c 'command -v ip; command -v nc; echo "exit_code=$?"'
```

**▼ 実行結果**

```plaintext
（途中省略：イメージのビルドの表示）
/usr/sbin/ip
/usr/bin/nc
exit_code=0
```

ランナーのラベル`ubuntu-latest`を、このイメージに向けて、ランナーのコンテナを作り直します。登録の情報はボリュームに残っているため、登録し直しは不要です。

**実行コマンド**

```plaintext
docker rm -f gitops04-runner
docker run -d --name gitops04-runner \
  -e GITEA_INSTANCE_URL=http://192.168.56.30:3000/ \
  -e GITEA_RUNNER_NAME=gitops04-runner \
  -e GITEA_RUNNER_LABELS=ubuntu-latest:docker://gitops04-runner-image:latest \
  -v gitops04-runner-data:/data \
  -v /var/run/docker.sock:/var/run/docker.sock \
  docker.io/gitea/runner:3
sleep 10
docker logs gitops04-runner 2>&1 | tail -10
```

**▼ 実行結果**

```plaintext
gitops04-runner
d1299c5e2191d42cdc83ef72070acf3260283f01b8e355042e61fbbf8c27765f
time="2026-10-04T05:52:15Z" level=info msg="Starting runner daemon"
time="2026-10-04T05:52:15Z" level=info msg="labels updated to: [ubuntu-latest:docker://gitops04-runner-image:latest]"
time="2026-10-04T05:52:15Z" level=info msg="runner: gitops04-runner, with version: v3.5.0, with labels: [ubuntu-latest], declare successfully"
```

同じ入力（`ubuntu-latest`、`172.19.0.4`）で実行しました。

**▼ 実行結果（3回目、ジョブのコンテナの起動）**

```plaintext
::group::Starting job container
image: gitops04-runner-image:latest
name: GITEA-ACTIONS-TASK-2-WORKFLOW-reachability-check-JOB-check-chec-574e281c446813a5dca754c0a7207a1009e4040245db7c124418267deb20aaff
network: GITEA-ACTIONS-TASK-2-WORKFLOW-reachability-check-JOB-check-chec-574e281c446813a5dca754c0a7207a1009e4040245db7c124418267deb20aaff-check-network
（途中省略：コンテナの作成の表示）
::endgroup::
```

**▼ 実行結果（3回目、ステップ「実行環境を表示する」）**

```plaintext
::group::Run echo "hostname=$(hostname)"
（途中省略：実行したスクリプトとシェルの表示）
::endgroup::
hostname=b45b518b2b34
runner_environment=self-hosted
2: eth0    inet 172.20.0.2/16 brd 172.20.255.255 scope global eth0\       valid_lft forever preferred_lft forever
```

**▼ 実行結果（3回目、ステップ「接続先のSSHポートに接続する」）**

```plaintext
::group::Run nc -zv -w 5 "${TARGET_HOST}" 22 && rc=0 || rc=$?
（途中省略：実行したスクリプト、シェル、環境変数の表示）
::endgroup::
nc: connect to 172.19.0.4 port 22 (tcp) timed out: Operation now in progress
exit_code=1
```

今度は両方のステップが実行されましたが、接続はタイムアウトしました。ジョブのコンテナは、ジョブ専用のネットワーク（`172.20.0.2/16`）にいて、操作対象のネットワーク（`172.19.0.0/16`）とは別のネットワークでした。

**4回目：ジョブのコンテナを、操作対象のネットワークにつなぐ**

ランナーの設定ファイルで、ジョブのコンテナをつなぐネットワークを指定します。既定の設定ファイルを生成し、`container`の`network`を`ansible-lab-net`に書き換えます。

**実行コマンド**

```plaintext
docker run --rm --entrypoint="" docker.io/gitea/runner:3 gitea-runner generate-config > gitops04-runner-config.yaml
sed -i 's/^  #network: ""$/  network: "ansible-lab-net"/' gitops04-runner-config.yaml
grep -n -E '^  #?network:' gitops04-runner-config.yaml
```

**▼ 実行結果**

```plaintext
Command "generate-config" is deprecated, use `config generate` instead.
208:  network: "ansible-lab-net"
```

この設定ファイルを渡して、ランナーのコンテナを作り直します。

**実行コマンド**

```plaintext
docker rm -f gitops04-runner
docker run -d --name gitops04-runner \
  -e GITEA_INSTANCE_URL=http://192.168.56.30:3000/ \
  -e GITEA_RUNNER_NAME=gitops04-runner \
  -e GITEA_RUNNER_LABELS=ubuntu-latest:docker://gitops04-runner-image:latest \
  -e CONFIG_FILE=/config.yaml \
  -v /tmp/gitops04-image/gitops04-runner-config.yaml:/config.yaml:ro \
  -v gitops04-runner-data:/data \
  -v /var/run/docker.sock:/var/run/docker.sock \
  docker.io/gitea/runner:3
sleep 10
docker logs gitops04-runner 2>&1 | tail -10
```

**▼ 実行結果**

```plaintext
gitops04-runner
6b2d1e581d4c95994f329435d6230c95f1bfcd54b8f3493d6f6d10072540f1ab
time="2026-10-04T05:57:51Z" level=info msg="Starting runner daemon"
time="2026-10-04T05:57:51Z" level=info msg="runner: gitops04-runner, with version: v3.5.0, with labels: [ubuntu-latest], declare successfully"
```

同じ入力で実行しました。

**▼ 実行結果（4回目、ジョブのコンテナの起動）**

```plaintext
::group::Starting job container
image: gitops04-runner-image:latest
name: GITEA-ACTIONS-TASK-3-WORKFLOW-reachability-check-JOB-check-chec-36e234804255bdb81e42bcc3b94c0aefda5a6b13513e3bbe62afa94fa2074451
network: ansible-lab-net
（途中省略：コンテナの作成の表示）
::endgroup::
```

**▼ 実行結果（4回目、ステップ「実行環境を表示する」）**

```plaintext
::group::Run echo "hostname=$(hostname)"
（途中省略：実行したスクリプトとシェルの表示）
::endgroup::
hostname=1a9e0db4a368
runner_environment=self-hosted
2: eth0    inet 172.19.0.5/16 brd 172.19.255.255 scope global eth0\       valid_lft forever preferred_lft forever
```

**▼ 実行結果（4回目、ステップ「接続先のSSHポートに接続する」）**

```plaintext
::group::Run nc -zv -w 5 "${TARGET_HOST}" 22 && rc=0 || rc=$?
（途中省略：実行したスクリプト、シェル、環境変数の表示）
::endgroup::
Connection to 172.19.0.4 22 port [tcp/ssh] succeeded!
exit_code=0
```

### ■ 結果

同じワークフローの4回の実行を並べると、次のとおりです。

|実行|`runs-on`|ランナーの側で変えたこと|ジョブを実行した場所|結果|
|---|---|---|---|---|
|1回目|`self-hosted`|なし|（ランナーに割り当てられない）|待機したまま（一致するランナーがない）|
|2回目|`ubuntu-latest`|なし|既定のイメージのコンテナ、ジョブ専用のネットワーク|`ip: command not found`で失敗|
|3回目|`ubuntu-latest`|ジョブのイメージに`ip`と`nc`を加えた|ジョブ専用のネットワーク（`172.20.0.2/16`）|タイムアウト（`exit_code=1`）|
|4回目|`ubuntu-latest`|ジョブのコンテナを`ansible-lab-net`につないだ|操作対象のネットワーク（`172.19.0.5/16`）|接続成功（`exit_code=0`）|

ワークフローのファイルは、4回とも、GitHubで使ったものから1文字も変えていません。手動実行のトリガー（`workflow_dispatch`）と入力の選択肢、`env`での値の受け渡し、`RUNNER_ENVIRONMENT`の環境変数は、Giteaでもそのまま使えました。

一方、そのままでは動きませんでした。差は、ワークフローの記法ではなく、ランナーの側にありました。

* ラベルの意味：GitHubの`ubuntu-latest`はホステッドランナーを指しますが、Giteaの`ubuntu-latest`は、自分で起動したランナーが、指定のイメージで作るコンテナを指します。同じ名前のラベルでも、ジョブがどこで実行されるかは、Git基盤とランナーの設定で決まります。
* ジョブのイメージに含まれるツール：GitHubのホステッドランナーにあった`ip`コマンドが、Giteaの既定のイメージにはありませんでした。
* ジョブのネットワーク：Giteaのランナーは、既定ではジョブごとに別のネットワークを作るため、Git基盤もランナーも操作対象と同じホストにあるのに、ジョブからは操作対象に届きませんでした。ジョブのコンテナを操作対象のネットワークにつなぐと、届きました。

3つ目の結果は、**[セクション2](#2-パイプラインはどこで実行されるのか)** と同じことを示しています。到達性を決めるのは、Git基盤やランナーをどこに置いたかではなく、ジョブが実際に実行される場所のネットワークです。Git基盤とランナーを操作対象と同じネットワークに置いても、ジョブがその中の別のネットワークで実行されれば、操作対象には届きません。この構造は、GitLabなど他のセルフホスト型のGit基盤でも同じで、ランナーがジョブをどこで実行するか（ホストの上か、コンテナの中か、どのネットワークか）を確認する必要があります。

なお、Giteaは、この回の比較のために用意したもので、以降の回では使いません。

次のセクションでは、ここまでの結果をもとに、4つの基準で3つの構成を比較し、本シリーズの採用構成を決めます。

---

[↑ 目次に戻る](#-目次)

---

## 6. 4つの基準による比較と採用構成

**[セクション2](#2-パイプラインはどこで実行されるのか)** から **[セクション5](#5-セルフホスト型git基盤でも同じワークフローは動くのか)** の結果をもとに、3つの構成を、到達性、状態の永続性、機密情報の置き場所、運用負荷の4つの基準で比較し、本シリーズの採用構成を決めます。

### 4つの基準による比較

|基準|GitHub（ホステッドランナー）|GitHub（self-hostedランナー）|セルフホスト型Git基盤（Gitea）|
|---|---|---|---|
|到達性|プライベートなネットワークの中の操作対象には届かない（**[セクション2](#2-パイプラインはどこで実行されるのか)**）。届くのは、ランナーの中に作った操作対象だけ|操作対象と同じネットワークで実行するため届く（**[セクション3](#3-到達性を確保する3つの構成)**）|ジョブを実行する場所を、操作対象のネットワークにつなげば届く（**[セクション5](#5-セルフホスト型git基盤でも同じワークフローは動くのか)**）|
|状態の永続性|ランナーの中に作った操作対象は、実行のたびに作り直される（**[セクション4](#4-状態の永続性とドリフト観測)**）|操作対象はランナーの外で存在し続け、実行をまたいだ変化を観測できる（**[セクション4](#4-状態の永続性とドリフト観測)**）|操作対象がランナーの外で存在し続ける点は、self-hostedランナーと同じ構造|
|機密情報の置き場所|コード、Secrets、ジョブのログを、GitHubに置く|コード、Secrets、ジョブのログを、GitHubに置く。ジョブの実行だけが自分のネットワークの中になる|コード、Secrets、ジョブのログを、すべて自分のネットワークの中に置ける|
|運用負荷|ランナーの運用はない|ランナーを置くホストと、ランナーの運用を抱える|Git基盤そのもの（バックアップ、バージョンアップ、認証、可用性）に加え、ランナーと、ジョブを実行するイメージやネットワークの設定を抱える|

### 差が出るのは、機密情報の置き場所と運用負荷

到達性と状態の永続性は、self-hostedランナーを置けば、GitHubでもセルフホスト型のGit基盤でも満たせます。どちらも、ジョブを操作対象と同じネットワークで実行し、操作対象をランナーの外に置き続ける構成だからです。2つの構成の差は、残りの2つの基準に出ます。

機密情報の置き場所については、self-hostedランナーを使っても、ジョブのログはGitHubに残ります。**[セクション3](#3-到達性を確保する3つの構成)** でself-hostedランナーが出力したログには、ランナーを置いたホストのネットワークの構成（IPアドレスやネットワークの名前）がそのまま含まれていて、そのログは、GitHubの画面で表示したものです。パイプラインでAnsibleを実行すれば、Ansibleの出力も同じようにログとしてGitHubに残ります。コードとSecretsも、GitHubの上にあります。

運用負荷については、セルフホスト型のGit基盤では、Git基盤そのものを自分で運用することになります。**[セクション5](#5-セルフホスト型git基盤でも同じワークフローは動くのか)** では、Giteaを起動するだけでなく、ジョブを実行するイメージに必要なツールを加え、ジョブのコンテナをつなぐネットワークを設定して、ようやく操作対象に届きました。GitHubのself-hostedランナーでは、ランナーを置くホストの運用は必要ですが、Git基盤の運用はありません。

### 判断は「外に置くかどうか」ではなく「どこまで預けるか」

クラウドのインフラを使っている時点で、操作対象もデータも、すでに外部の事業者の上にあります。そのため、この判断は、「外部に置くか、置かないか」ではなく、「どこまでを外部の事業者に預けるか」という、信頼の境界をどこに引くかの問題になります。

GitHubのself-hostedランナーの構成は、コード、Secrets、ジョブのログをGitHubに預け、ジョブの実行と操作対象への接続だけを自分のネットワークの中に置く、という線の引き方です。セルフホスト型のGit基盤の構成は、そのすべてを自分のネットワークの中に置く線の引き方です。どちらが正しいかは、構成からは決まりません。要件で決まります。

* コード、Secrets、ジョブのログを外部に置けない要件がある場合：セルフホスト型のGit基盤を選ぶ
* その要件がなく、Git基盤の運用を抱えたくない場合：GitHubと、操作対象と同じネットワーク内のself-hostedランナーを選ぶ

### 本シリーズの採用構成

本シリーズは、GitHubと、操作対象と同じネットワーク内に置くself-hostedランナーを採用し、第2部以降の実行基盤として固定します。理由は次の3つです。

* 記事に載せるワークフローとコードを使えば、読者が自分のGitHubのアカウントの上で、同じ構成を再現できるため
* 操作対象が実行のたびに作り直されず、状態が継続するため。第4部（**[第17回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part4/ansible-gitops-part4-17/)** 〜 **[第21回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part4/ansible-gitops-part4-21/)**）のドリフトの検知と自動収束は、この前提の上に成り立つ
* GitHub Actionsは、組織の中で使われているCI/CDのツールとして最も多く、読者が実務で触れる可能性が高いため。JetBrainsが公開している調査（**[Best CI/CD Tools for 2026: What the Data Actually Shows](https://blog.jetbrains.com/teamcity/2026/03/best-ci-tools/)**）では、組織での利用はGitHub Actionsが33%、Jenkinsが28%、GitLab CIが19%とされている

### リポジトリを非公開で運用する理由

本シリーズの **[第3回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part1/ansible-gitops-part1-03/)** では、リポジトリを非公開で運用することを前提にしました。その理由は、self-hostedランナーを使うことにあります。

GitHubの公式ドキュメント（**[Secure use reference](https://docs.github.com/en/actions/reference/security/secure-use)**）では、ホステッドランナーは実行のたびに使い捨てられる仮想マシンでコードを実行するのに対し、self-hostedランナーにはその保証がなく、ワークフローの中の信頼できないコードによって、継続的に乗っ取られるおそれがあるとされています。そのうえで、公開リポジトリでは誰でもプルリクエストを作れるため、self-hostedランナーは公開リポジトリではほぼ使うべきではない、としています。非公開のリポジトリでも、リポジトリをフォークしてプルリクエストを作れる人（一般には読み取りの権限を持つ人）は、self-hostedランナーの環境を乗っ取れるとして、注意を促しています。

本シリーズのself-hostedランナーは、操作対象と同じホストで動き、操作対象に接続でき、tfstateやTerraformが生成した秘密鍵も、同じホストにあります。このランナーでコードを実行できる人は、インフラそのものを操作できる人です。そのため、リポジトリは非公開にし、読み取りの権限を持つ人も、インフラを操作してよい人に限ります。リポジトリを非公開にすることは、ランナーで動くコードを書ける人の範囲を、信頼の境界の内側に限るための線の引き方です。

### セルフホスト型のGit基盤を選ぶ場合

第2部以降で作るパイプラインの構造は、セルフホスト型のGit基盤とそのCIを選んだ場合でも同じです。**[セクション5](#5-セルフホスト型git基盤でも同じワークフローは動くのか)** で確認したとおり、ワークフローの記法はGiteaでもそのまま使え、差はランナーの側（ラベルの意味、ジョブのイメージ、ジョブのネットワーク）にありました。セルフホスト型を選ぶ場合は、この差をランナーの設定で埋めたうえで、同じ構造のパイプラインを組めます。

また、GitHubを選んだ場合でも、外部に預ける範囲を狭める設計はできます。たとえば、長期間有効なクラウドの認証情報をSecretsに置かずに済ませる方法があります。こうした、外部に預ける機密情報を減らす設計は、第3部（**[第13回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part3/ansible-gitops-part3-13/)** 〜 **[第16回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part3/ansible-gitops-part3-16/)**）で扱います。

次のセクションでは、この回で整理した判断が、クラウドのプロバイダーでも同じように必要になる理由を整理します。

---

[↑ 目次に戻る](#-目次)

---

## 7. クラウドでも同じ判断が必要になる理由

この回で整理した到達性と信頼の境界の判断が、Dockerプロバイダーに固有のものではなく、AWSやGCPでも同じように必要になることを整理します。

### TerraformとAnsibleで、接続先の場所が違う

**[セクション2](#2-パイプラインはどこで実行されるのか)** で整理したとおり、パイプラインが成立するには、TerraformとAnsibleのそれぞれの接続先に、ランナーから届く必要があります。この接続先が、プロバイダーによって次のように変わります。

|ツール|Docker（本シリーズの検証環境）|AWS|GCP|
|---|---|---|---|
|Terraform|操作対象と同じホストのDocker|AWSのAPI|GCPのAPI|
|Ansible|コンテナのSSHのポート（Dockerのプライベートなネットワーク）|インスタンスのSSHのポート（VPCのプライベートサブネット）|インスタンスのSSHのポート（VPCのプライベートサブネット）|

この検証環境では、Terraformの接続先もAnsibleの接続先も、同じホストの中にあります。そのため、self-hostedランナーを同じホストに置けば、両方に届きました。

クラウドでは、TerraformとAnsibleの接続先の場所が分かれます。Terraformが接続するクラウドのAPIは、通常、インターネットから到達できる場所で提供されています。認証情報さえ渡せば、ホステッドランナーからでもTerraformは動きます。一方、Ansibleが接続するインスタンスは、プライベートサブネットに置かれていれば、インターネットからは届きません。

### 「Terraformは動くのに、Ansibleだけ失敗する」

その結果、ホステッドランナーでパイプラインを組むと、`terraform plan`も`terraform apply`も成功し、インスタンスは作られるのに、その後の`ansible-playbook`だけがSSHの接続で失敗する、という状態になります。**[セクション1](#1-はじめに)** で挙げた「`terraform plan`は通るのに、Ansibleだけが失敗する」という場面は、この構造から生まれます。

Terraformが動いていることは、パイプラインが操作対象に届いていることを意味しません。届いているのはクラウドのAPIまでで、インスタンスの中には届いていないからです。この場合も、**[セクション3](#3-到達性を確保する3つの構成)** の構成2のように、ランナーをインスタンスと同じVPCの中に置く必要があります。セルフホスト型のGit基盤を選ぶ場合も、Git基盤とランナーを、インスタンスに届く場所に置くことになります。

### 判断の基準は、プロバイダーを問わず同じ

この回で使った基準は、プロバイダーを差し替えても、そのまま使えます。

* 到達性：TerraformとAnsibleのそれぞれの接続先に、ジョブが実行される場所から届くか（**[セクション2](#2-パイプラインはどこで実行されるのか)**、**[セクション3](#3-到達性を確保する3つの構成)**、**[セクション5](#5-セルフホスト型git基盤でも同じワークフローは動くのか)**）
* 状態の永続性：操作対象が実行をまたいで存在し続け、その変化を観測できるか（**[セクション4](#4-状態の永続性とドリフト観測)**）
* 機密情報の置き場所と運用負荷：どこまでを外部の事業者に預け、何を自分で運用するか（**[セクション6](#6-4つの基準による比較と採用構成)**）

変わるのは、接続先がDockerかクラウドのAPIか、操作対象がDockerのネットワークにあるかVPCにあるか、という個々の場所です。クラウドでは、Terraformに渡すクラウドの認証情報も、外部に預けるものに加わります。その扱いは、第3部（**[第13回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part3/ansible-gitops-part3-13/)** 〜 **[第16回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part3/ansible-gitops-part3-16/)**）で扱います。

次のセクションでは、この回で整理した内容をまとめます。

---

[↑ 目次に戻る](#-目次)

---

## 8. まとめ

この回で整理した内容を確認します。

* パイプラインをどこに置くかは、機能の比較では決まらず、ジョブが実行される場所から操作対象に届くかと、何を外部に預けるかという信頼の境界で決まる
* GitHubのホステッドランナーは、ジョブごとに用意される仮想マシンで動き、プライベートなネットワークの中にある操作対象のSSHのポートには届かないことを実機で確認した。同じ接続先に、操作対象と同じホストからは届いた
* ランナーから操作対象に届くようにする構成は、ランナーの中で環境ごと作る構成、操作対象と同じネットワークにself-hostedランナーを置く構成、操作対象と同じネットワークにGit基盤とCIのランナーを置く構成の3つがある。self-hostedランナーは外向きのHTTPSでジョブを受け取り、操作対象と同じホストに置いたランナーから届くことを実機で確認した
* ランナーの中で環境ごと作る構成では、操作対象が実行のたびに作り直されるため、実行をまたいだ変化を観測できない。self-hostedランナーでは、2回の実行で同じ操作対象に接続し、その間に加えた手動変更を観測できることを実機で確認した。これが第4部のドリフトの検知と自動収束の前提になる
* セルフホスト型のGit基盤（Gitea）では、ワークフローの記法はそのまま使えたが、ラベルの意味、ジョブのイメージに含まれるツール、ジョブのネットワークの差により、そのままでは動かなかった。ジョブのコンテナを操作対象のネットワークにつなぐと届くことを実機で確認した。到達性を決めるのは、Git基盤やランナーの置き場所ではなく、ジョブが実際に実行される場所である
* 4つの基準で比較すると、到達性と状態の永続性はself-hostedランナーで満たせ、差が出るのは機密情報の置き場所と運用負荷である。判断は「外に置くかどうか」ではなく「どこまでを外部の事業者に預けるか」であり、要件で決まる
* 本シリーズは、GitHubと、操作対象と同じネットワーク内に置くself-hostedランナーを採用し、第2部以降の実行基盤として固定する
* self-hostedランナーは、ワークフローの中の信頼できないコードによって継続的に乗っ取られるおそれがあり、公開リポジトリでは誰でもプルリクエストを作れるため、本シリーズはリポジトリを非公開で運用する
* クラウドでは、Terraformの接続先であるクラウドのAPIには届き、Ansibleの接続先であるプライベートサブネットのインスタンスには届かない、という形で同じ構造が現れる。到達性、状態の永続性、信頼の境界の判断は、プロバイダーを問わず同じである

---

[↑ 目次に戻る](#-目次)

---

## 9. 次回予告

本シリーズの **[第3回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part1/ansible-gitops-part1-03/)** では、変更の分類をGitリポジトリの構造に落とし込み、mainを唯一の真実とするブランチ運用を設計しました。第4回となる今回は、そのリポジトリをどこでホストし、パイプラインをどこで動かすかを扱いました。ホステッドランナーからはプライベートなネットワークの中の操作対象に届かないことを実機で確認し、到達性を確保する3つの構成を整理しました。そのうえで、self-hostedランナーでは実行をまたいだ変化を観測できること、セルフホスト型のGit基盤では、同じワークフローでもランナーの側の違いによってそのままでは動かないことを確認しました。最後に、4つの基準で比較して、選択が信頼の境界の要件で決まることを示し、本シリーズの採用構成と、リポジトリを非公開で運用する理由を整理しました。

今回で、第1部は終わりです。第1部では、**[第1回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part1/ansible-gitops-part1-01/)** でGitOpsの4原則を評価軸にAnsibleとTerraformの充足度を整理し、「唯一の真実」が崩れる3つの経路を示しました。**[第2回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part1/ansible-gitops-part1-02/)** では責務分担を変更の種類ごとに必要な実行として捉え直し、**[第3回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part1/ansible-gitops-part1-03/)** ではその分類をパスで判定するリポジトリの構造を設計しました。今回の実行基盤と信頼の境界を加えた4つが、第2部でパイプラインを組むための前提になります。

次回からは、第2部「GitHub Actionsによる自動化パイプライン」に入ります。**[第5回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-05/)** では、この回で導入したself-hostedランナーの上で、GitHub ActionsからAnsibleとTerraformを実行する基本の構成を組みます。プルリクエストで確認し、マージで適用する流れを実装し、変更されたパスによるジョブの切り替え、Terraform→Ansibleの実行順序の保証、実行時のインベントリの生成を扱います。**[第3回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part1/ansible-gitops-part1-03/)** で洗い出した、リポジトリの`terraform/`と`ansible/`への再配置も、ワークフローの作り直しとあわせて行います。

**[次回：第5回：GitHub ActionsからAnsibleを実行する基本構成](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-05/)**

---

📑 連載の移動　**[前の記事：【GitOps編】第3回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part1/ansible-gitops-part1-03/)　｜　[次の記事：【GitOps編】第5回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-05/)**

---

> **🗺️ 初めての方、シリーズの全体像を知りたい方はこちら**
>
> シリーズ全体については、以下のまとめブログで整理しています。
>
> → **「Ansible×TerraformをGitOpsで回す」〜Terraformプロバイダーを問わない構成管理の自動化〜 第1部まとめブログ：「Gitが唯一の真実」を成り立たせる前提の設計** **※近日公開予定**

---

[↑ 目次に戻る](#-目次)

---

## 10. 連載一覧：「Ansible×TerraformをGitOpsで回す」

### 第1部：GitOpsの基本概念とAnsibleとの接続

|回数|テーマ、記事タイトル|概要|
|---|---|---|
|**[第1回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part1/ansible-gitops-part1-01/)**|なぜ「Gitがインフラの唯一の真実」なのか|GitOpsの4原則を評価軸として、AnsibleとTerraformの充足度を整理する。push型構成の立ち位置と、「唯一の真実」が崩れる3つの経路を示す。|
|**[第2回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part1/ansible-gitops-part1-02/)**|AnsibleとTerraformのGitOps上での責務分担|責務分担を「変更の種類ごとに必要な実行」として捉え直す。変更の3分類、境界が曖昧な設定の判定基準、Gitの外にある接続面を整理する。|
|**[第3回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part1/ansible-gitops-part1-03/)**|GitリポジトリとAnsibleの構造設計|変更の分類をパスで表現するディレクトリ構成、Gitに置くもの・置かないもの、モノレポとマルチリポの選択基準、mainを唯一の真実とするブランチ運用を設計する。無料プランの非公開リポジトリでは直接プッシュを防げないため、強制する場所を適用前に移す方針を示す。|
|**[第4回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part1/ansible-gitops-part1-04/)**|ローカルGitea vs GitHub Actionsの選択基準|到達性・状態の永続性・機密情報の置き場所・運用負荷の4基準で比較し、選択が信頼境界の要件で決まることを示す。本シリーズはGitHub＋self-hostedランナーを採用し、リポジトリを非公開で運用する。第1部の最終回。|

---

[↑ 目次に戻る](#-目次)

---