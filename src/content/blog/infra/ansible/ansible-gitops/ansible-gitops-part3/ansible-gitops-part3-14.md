---
title: '「Ansible×TerraformをGitOpsで回す」〜Terraformプロバイダーを問わない構成管理の自動化〜 第14回：Ansible VaultをGitOpsパイプラインで安全に扱う'
description: '第13回で位置づけた「Gitに置くが読めなくする」選択肢として、Ansible VaultをGitOpsのパイプラインに組み込む。Vaultパスワードをジョブにどう渡すか、暗号化の単位とプルリクエストのレビューをどう両立させるか、復号した値をジョブのログや差分にどう出さないかを、パイプラインの設計として扱う。暗号化し忘れを止める場所と、環境ごとにVaultパスワードを分けたときの限界も示す。'
pubDate: 2026-10-16
category: 'infra'
tags: ['Ansible', 'Terraform', 'GitOps', 'GitHub Actions', 'Ansible Vault']
seriesId: 'ansible-gitops-part3'
seriesNo: 14
prevPost: 'https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part3/ansible-gitops-part3-13/'
nextPost: 'https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part3/ansible-gitops-part3-15/'
relatedSeries: ''
---

<style> table th, table td { word-break: normal; } table td:first-child { white-space: nowrap; } </style>


> **🗺️ 初めての方、シリーズの全体像を知りたい方はこちら**
>
> シリーズ全体については、以下のまとめブログで整理しています。
>
> → **「Ansible×TerraformをGitOpsで回す」〜Terraformプロバイダーを問わない構成管理の自動化〜 第3部まとめブログ：機密情報は「どこに置くか」だけでなく「どこに残るか」で設計する** **※近日公開予定**

---

## 📋 目次

1. [はじめに](#1-はじめに)
2. [秘密はVaultパスワードに移る](#2-秘密はvaultパスワードに移る)
3. [self-hostedランナーに一時ファイルが残る](#3-self-hostedランナーに一時ファイルが残る)
4. [暗号化の単位とレビューのしやすさ](#4-暗号化の単位とレビューのしやすさ)
5. [復号した値はログと差分に出る](#5-復号した値はログと差分に出る)
6. [暗号化し忘れを止めるガードレール](#6-暗号化し忘れを止めるガードレール)
7. [環境ごとにVaultパスワードを分ける](#7-環境ごとにvaultパスワードを分ける)
8. [クラウドでも3つの問題は同じ](#8-クラウドでも3つの問題は同じ)
9. [まとめ](#9-まとめ)
10. [次回予告](#10-次回予告)
11. [連載一覧：「Ansible×TerraformをGitOpsで回す」](#11-連載一覧ansibleterraformをgitopsで回す)

---

## 1. はじめに

TerraformとAnsibleのパイプラインで、機密情報をAnsible Vaultで扱っていて、

* パスワードは、Ansible Vaultで暗号化してからコミットした
* Vaultパスワードは、GitHubのSecretsに登録した
* よって、パイプラインのどこからも、秘密の値は漏れない

と考えていないでしょうか。

Ansible Vaultを扱う記事の多くは、暗号化と復号のコマンドや、CIでVaultパスワードを渡す設定を中心にしています。暗号化した値をGitOpsのパイプラインに載せたときに、プルリクエストのレビュー、承認の材料、ジョブのログで、何が見え、何が残るかは、あまり扱われていません。Ansible Vaultをパイプラインで使い始めると、次のような場面にぶつかります。

* 暗号化した変数ファイルのプルリクエストで、差分が暗号文の塊になり、何が変わったのか分からなかった
* 承認の材料として見た`--check --diff`の差分に、復号したパスワードがそのまま出ていた
* ランナーのホストに、Vaultパスワードを書き出したファイルが残っていた
* 暗号化し忘れた変数を、そのままコミットしてマージしてしまった

これらは、Ansible Vaultの使い方の誤りに見えます。共通しているのは、Ansible Vaultで暗号化しても、秘密の値がパイプラインのどこに、どういう形で現れるかが、パイプラインの構造として決まっていない点です。

Ansible Vaultは、「AnsibleとTerraformの連携が壊れる理由はライフサイクルにあった」（以下、Ansible×Terraformシリーズ）でも扱ってきました。**[Ansible×Terraformシリーズ第18回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part2/ansible-terraform-part2-18/)** では、Ansible Vaultがファイルの内容そのものを暗号化し、正しいVaultパスワードがなければ復号できないことを確かめました。同じ回では、`ansible-vault encrypt_string`で変数の値だけを暗号化すれば、変数名を平文のまま残せることも確認しています。そのうえで、インフラの中身に設定する鍵はAnsible Vaultの側に置くという役割分担を整理し、Vaultパスワード自体の平文共有や、暗号化の粒度が粗いことによる非効率を、誤用のパターンとして挙げました。これらの確認は、手元から`--ask-vault-pass`でVaultパスワードを入力して行ったもので、Vaultパスワードをパイプラインのジョブにどう渡すかや、復号した値がジョブのログにどう出るかは扱っていません。

本シリーズの **[第3回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part1/ansible-gitops-part1-03/)** のセクション3では、Gitに置くかどうかを、中身が「決めたこと」か「実行の結果」かで分け、決めたことであっても、パスワードのような秘密の値はGitに置かないとしました。**[第4回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part1/ansible-gitops-part1-04/)** のセクション6では、GitHubとself-hostedランナーの構成は、コード、Secrets、ジョブのログをGitHubに預ける線の引き方だと整理しました。**[第7回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-07/)** では、Ansibleの`--check --diff`の出力を承認の材料にし、`--diff`は書き込む内容をそのままログに表示するため、機密の値を配置するタスクでは、その値がログに出るおそれがあるとして、その扱いをこの回に送りました。**[第12回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-12/)** のセクション5では、ジョブのログの伏せ字が、Secretsに登録した値にしか効かないことを確認し、`--diff`で機密を含むファイルの差分を出した場合に何がログに出るかは、確かめていないとしました。

**[第13回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part3/ansible-gitops-part3-13/)** では、第2部（第5回〜第12回）で暫定のまま残した機密情報を、パイプラインがツールを動かすための鍵と、操作対象に入れる秘密の値の2種類に分けて棚卸ししました。そのうえで、機密情報を平文でGitに置かない方法を、「Gitに置かない」と「Gitに置くが読めなくする」の2つに整理しました。後者は、値の変更をコミットとしてGitの履歴に残し、プルリクエストと承認ゲートを通せる一方で、復号の鍵であるVaultパスワードをGitの外で守る必要が生まれ、Vaultパスワードもツールを動かすための鍵に加わります。また、どちらを選んでも、値の渡し方しだいで、Gitの外の経路には値が残ります。

第14回となる今回は、**[第13回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part3/ansible-gitops-part3-13/)** で位置づけた「Gitに置くが読めなくする」選択肢として、Ansible VaultをGitOpsのパイプラインに組み込みます。対象は、操作対象に入れる秘密の値のうち、Ansibleだけが使う値とします。コンテナのユーザーのパスワードのように、Terraformを経由して渡している値の扱いは、**[第15回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part3/ansible-gitops-part3-15/)** の役割分担で扱います。まず、値をVaultで暗号化すると、守るべき秘密がVaultパスワードに集まることを確かめ、Vaultパスワードをパイプラインのジョブにどう渡すかを比べます。次に、self-hostedランナーで、Vaultパスワードを書き出したファイルが、ランナーのホストに残る経路を確かめます。そのうえで、暗号化の単位によってプルリクエストの差分の見え方がどう変わるかと、復号した値が`--check --diff`のジョブのログにどう出るかを確かめ、レビューのために見せたいものと、漏らさないために隠したいものが、どこでぶつかるかを整理します。さらに、暗号化し忘れた値を、どこで止めればよいかを、**[第8回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-08/)** と **[第9回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-09/)** のガードレールと比べて示します。最後に、**[第10回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-10/)** の3つの環境でVaultパスワードを分けたときの限界と、この構造がクラウドのプロバイダーでも変わらないことを整理します。

正確に言うと、**Ansible Vaultで暗号化しても、秘密の値は、Vaultパスワード、レビューの差分、ジョブのログへと形を変えて、パイプラインに現れます。暗号化することに加えて、それぞれの場所で何を見せ、何を残さないかを、パイプラインの設計として決める必要があります**。この回で扱う問いは、「暗号化してGitに置いた秘密の値は、パイプラインのどこに現れ、それぞれの場所で何を見せ、何を残さないように設計すればよいのか」です。

次のセクションでは、Vaultで暗号化したときに、守るべき秘密がどこに移るのかを確かめます。

---

[↑ 目次に戻る](#-目次)

---

## 2. 秘密はVaultパスワードに移る

値をAnsible Vaultで暗号化したときに、守るべき秘密がどこに集まるかを整理し、その秘密をパイプラインのジョブにどう渡すかを、2つの方法で確かめます。

### 暗号化すると、守るべき秘密はVaultパスワードに集まる

**[Ansible×Terraformシリーズ第18回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part2/ansible-terraform-part2-18/)** で確かめたとおり、Ansible Vaultで暗号化した値は、正しいVaultパスワードがなければ復号できません。言い換えると、暗号化した値がいくつあっても、それらが守られるかどうかは、Vaultパスワード1つが守られるかどうかで決まります。暗号化は、守るべき秘密をなくすのではなく、多くの値を、1つのVaultパスワードの後ろに集める仕組みです。

そのVaultパスワードは、少なくとも2つの場所で必要になります。

* 値を暗号化したり、書き換えたりする人の手元
* 暗号化した値を復号して使う、パイプラインのジョブ

Ansibleの公式ドキュメント（**[Managing vault passwords](https://docs.ansible.com/projects/ansible/latest/vault_guide/vault_managing_passwords.html)**）では、Vaultパスワードをファイルに置く場合は、1行で書き、ファイルの権限を適切にし、ソース管理には入れないこととされています。外部の保管場所から取り出す場合は、名前を`-client`で終わらせた、実行できるスクリプトを用意し、パスワードを標準出力に出させて、Ansibleから呼び出す方法が示されています。

**[第13回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part3/ansible-gitops-part3-13/)** のセクション6で整理したとおり、Vaultパスワードは、パイプラインがツールを動かすための鍵に加わります。ここでは、この検証環境でVaultパスワードを用意し、手元とGitHubのSecretsの2か所に置いたうえで、ジョブへの渡し方を比べます。

### ■ 検証内容：Vaultパスワードを用意する

Vaultパスワードは、ジョブのログに頻繁に現れる語と重ならないよう、ランダムな値にします。**[第5回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-05/)** のセクション5で確認したとおり、Secretsに登録した値と一致する文字列は、ログの中で`***`に伏せられ、値が頻出する語と同じだと、伏せられ方から値を推測できてしまうためです。置き場所は、リポジトリの外の、本人だけが読めるディレクトリにし、値は画面に表示しません。

**実行コマンド**

```plaintext
ansible-vault --version | head -1
mkdir -p -m 700 ~/.config/ansible-vault
(umask 077; openssl rand -hex 24 > ~/.config/ansible-vault/gitops14-vault-pass)
ls -ld ~/.config/ansible-vault
ls -l ~/.config/ansible-vault
wc -c < ~/.config/ansible-vault/gitops14-vault-pass
```

**▼ 実行結果**

```plaintext
ansible-vault [core 2.17.14]
drwx------ 2 control control 4096 Oct 16 01:07 /home/control/.config/ansible-vault
total 4
-rw------- 1 control control 49 Oct 16 01:07 gitops14-vault-pass
49
```

Vaultパスワードは、16進数の48文字と改行の49バイトで、本人だけが読める権限（`-rw-------`）のファイルになりました。

続いて、同じ値を、GitHubのリポジトリの「Settings」→「Secrets and variables」→「Actions」で、`ANSIBLE_VAULT_PASSWORD`という名前で登録しました。登録の後の一覧は、次のとおりです。

|名前|画面の最終更新の表示|
|---|---|
|`ANSIBLE_VAULT_PASSWORD`|now|
|`PG_CONN_STR`|last week|
|`TF_VAR_ANSIBLE_USER_PASSWORD`|last month|
|`TF_VAR_DEPLOY_USER_PASSWORD`|last month|

### パイプラインへの2つの渡し方

Secretsに登録した値は、ワークフローの中で環境変数としてジョブに渡せます。そこから`ansible-playbook`などにVaultパスワードを渡す方法として、次の2つを比べます。どちらも、`--vault-password-file`を使います。

|渡し方|方法|リポジトリに置くもの|
|---|---|---|
|A：一時ファイル|ジョブの中で、環境変数の値をファイルに書き出し、そのファイルを`--vault-password-file`に渡す|なし|
|B：スクリプト|環境変数の値を標準出力に出すだけのスクリプトをリポジトリに置き、そのスクリプトを`--vault-password-file`に渡す|スクリプト（値は含まない）|

### ■ 検証内容：2つの渡し方で、ジョブの中で復号する

作業用のブランチで、次の3つのファイルを作ります。どれも、この確認のためだけのもので、mainにはマージしません。

|ファイル|内容|
|---|---|
|`ansible/gitops14/vault_check.yml`|ダミーの値（`gitops14-section2-dummy`）を`encrypt_string`で暗号化した変数`gitops14_check_value`|
|`.github/scripts/vault-pass.sh`|渡し方B用。環境変数`ANSIBLE_VAULT_PASSWORD`の値を出力するだけのスクリプト|
|`.github/workflows/vault-pass-check.yml`|確認用のワークフロー。作業用のブランチへのプッシュでだけ動く|

復号できたかどうかは、復号した値を表示せず、`gitops14_check_value == 'gitops14-section2-dummy'`の比較の結果（`true`か`false`）だけを表示して確かめます。

**実行コマンド**

```plaintext
cd ~/iac/docker-lab-ci
git switch -c gitops14-vault-pass
mkdir -p ansible/gitops14
printf -- '---\n' > ansible/gitops14/vault_check.yml
ansible-vault encrypt_string --vault-password-file ~/.config/ansible-vault/gitops14-vault-pass --name gitops14_check_value 'gitops14-section2-dummy' >> ansible/gitops14/vault_check.yml
cat > .github/scripts/vault-pass.sh <<'EOF'
（スクリプトの内容。下のcat -nの結果と同じ）
EOF
chmod +x .github/scripts/vault-pass.sh
cat > .github/workflows/vault-pass-check.yml <<'EOF'
（ワークフローの内容。下のファイルと同じ）
EOF
cat -n ansible/gitops14/vault_check.yml
cat -n .github/scripts/vault-pass.sh
ls -l .github/scripts/vault-pass.sh
git check-ignore -v ansible/gitops14/vault_check.yml .github/scripts/vault-pass.sh .github/workflows/vault-pass-check.yml; echo "check_ignore_exit_code=$?"
```

**▼ 実行結果**

```plaintext
Switched to a new branch 'gitops14-vault-pass'
     1  ---
     2  gitops14_check_value: !vault |
     3            $ANSIBLE_VAULT;1.1;AES256
     4            61316230323334656466636638396536656137616138313531303966383265316233373534383939
     5            6465336233396163323930396538613736643939626632310a643832393436383231343565653065
     6            32356265663366376666643634376631376531653137626238613336643532616666383766626436
     7            6662306163386432340a323131393539346237653930343566333635656362346164656238396631
     8            39313030653032636537636264393836366539383431656563373063303532383933
     1  #!/usr/bin/env bash
     2  # 環境変数ANSIBLE_VAULT_PASSWORDの値を、Vaultパスワードとして標準出力に出す
     3  set -euo pipefail
     4  if [ -z "${ANSIBLE_VAULT_PASSWORD:-}" ]; then
     5    echo "ANSIBLE_VAULT_PASSWORD is not set" >&2
     6    exit 1
     7  fi
     8  printf '%s\n' "$ANSIBLE_VAULT_PASSWORD"
-rwxrwxr-x 1 control control 282 Oct 16 06:13 .github/scripts/vault-pass.sh
check_ignore_exit_code=1
```

暗号化した値は、変数名`gitops14_check_value`だけが平文で、値は`$ANSIBLE_VAULT;1.1;AES256`から始まる暗号文になりました。スクリプトは実行できる権限で、3つのファイルは、どれも`.gitignore`で除外されていません（`check_ignore_exit_code=1`）。

確認用のワークフローは、次のとおりです。

* **ファイル名：`.github/workflows/vault-pass-check.yml`**

```yaml
name: Vault Pass Check

on:
  push:
    branches:
      - gitops14-vault-pass

jobs:
  vault-pass:
    runs-on: [self-hosted, Linux, X64]
    env:
      ANSIBLE_VAULT_PASSWORD: ${{ secrets.ANSIBLE_VAULT_PASSWORD }}
    steps:
      - uses: actions/checkout@v4
      - name: Add Ansible to PATH
        run: echo "$HOME/ansible-env/bin" >> "$GITHUB_PATH"
      - name: Show masking
        run: |
          echo "length=${#ANSIBLE_VAULT_PASSWORD}"
          echo "value=$ANSIBLE_VAULT_PASSWORD"
      - name: Decrypt with password file (A)
        run: |
          umask 077
          f="$RUNNER_TEMP/vault-pass-a"
          printf '%s\n' "$ANSIBLE_VAULT_PASSWORD" > "$f"
          ls -l "$f"
          ansible localhost -i localhost, -c local -m ansible.builtin.debug -a "msg={{ gitops14_check_value == 'gitops14-section2-dummy' }}" -e @ansible/gitops14/vault_check.yml --vault-password-file "$f"
          rm -f "$f"
      - name: Decrypt with script (B)
        run: |
          ansible localhost -i localhost, -c local -m ansible.builtin.debug -a "msg={{ gitops14_check_value == 'gitops14-section2-dummy' }}" -e @ansible/gitops14/vault_check.yml --vault-password-file .github/scripts/vault-pass.sh
      - name: Show files
        if: always()
        run: |
          ls -la "$RUNNER_TEMP"
          git status --ignored --short --untracked-files=all
```

Vaultパスワードは、ジョブの`env`で、Secretsから環境変数`ANSIBLE_VAULT_PASSWORD`に入れます。ステップ「Show masking」では、値の長さと、値そのものを`echo`して、ログでどう表示されるかを確かめます。渡し方Aの一時ファイルは、ランナーがジョブごとに用意する一時ディレクトリ（`$RUNNER_TEMP`）に書き出し、同じステップの中で削除します。一時ファイルの置き場所による違いは、**[セクション3](#3-self-hostedランナーに一時ファイルが残る)** で扱います。

プッシュする前に、手元で2つの渡し方を確かめます。渡し方Bは、手元のVaultパスワードを環境変数に入れて試します。

**実行コマンド**

```plaintext
cd ~/iac/docker-lab-ci
echo "== local A"
ansible localhost -i localhost, -c local -m ansible.builtin.debug -a "msg={{ gitops14_check_value == 'gitops14-section2-dummy' }}" -e @ansible/gitops14/vault_check.yml --vault-password-file ~/.config/ansible-vault/gitops14-vault-pass
echo "== local B"
ANSIBLE_VAULT_PASSWORD=$(cat ~/.config/ansible-vault/gitops14-vault-pass) ansible localhost -i localhost, -c local -m ansible.builtin.debug -a "msg={{ gitops14_check_value == 'gitops14-section2-dummy' }}" -e @ansible/gitops14/vault_check.yml --vault-password-file .github/scripts/vault-pass.sh
git add ansible/gitops14/vault_check.yml .github/scripts/vault-pass.sh .github/workflows/vault-pass-check.yml
git commit -m "GitOps第14回: Vaultパスワードの渡し方を確かめるワークフローを追加"
git push -u origin gitops14-vault-pass
```

**▼ 実行結果**

```plaintext
== local A
localhost | SUCCESS => {
    "msg": true
}
== local B
localhost | SUCCESS => {
    "msg": true
}
[gitops14-vault-pass 1d2bf85] GitOps第14回: Vaultパスワードの渡し方を確かめるワークフローを追加
 3 files changed, 52 insertions(+)
（途中省略：作成の一覧、プッシュの表示）
```

手元では、2つの渡し方のどちらでも復号できました。名前が`-client`で終わらないスクリプトでも、実行できる権限があれば、Ansibleはそれを実行し、出力をVaultパスワードとして使っています。

このプッシュで、「Vault Pass Check」の実行#1が起動し、`vault-pass`ジョブが成功しました。

**▼ 実行結果**（「Vault Pass Check」の実行#1、`vault-pass`ジョブのステップ「Run actions/checkout@v4」から抜粋）

```plaintext
（途中省略：入力の表示）
env:
  ANSIBLE_VAULT_PASSWORD: ***
（以下省略）
```

**▼ 実行結果**（「Vault Pass Check」の実行#1、`vault-pass`ジョブのステップ「Show masking」から抜粋）

```plaintext
（途中省略：実行したスクリプト、シェル、環境変数の表示）
length=48
value=***
```

**▼ 実行結果**（「Vault Pass Check」の実行#1、`vault-pass`ジョブのステップ「Decrypt with password file (A)」から抜粋）

```plaintext
（途中省略：実行したスクリプト、シェル、環境変数の表示）
-rw------- 1 control control 49 Oct 16 06:13 /home/control/actions-runner/_work/_temp/vault-pass-a
localhost | SUCCESS => {
    "msg": true
}
```

**▼ 実行結果**（「Vault Pass Check」の実行#1、`vault-pass`ジョブのステップ「Decrypt with script (B)」から抜粋）

```plaintext
（途中省略：実行したスクリプト、シェル、環境変数の表示）
localhost | SUCCESS => {
    "msg": true
}
```

**▼ 実行結果**（「Vault Pass Check」の実行#1、`vault-pass`ジョブのステップ「Show files」から抜粋）

```plaintext
（途中省略：実行したスクリプト、シェル、環境変数の表示）
total 36
drwxr-xr-x 4 control control 4096 Oct 16 06:13 .
drwxr-xr-x 7 control control 4096 Oct 16 06:13 ..
-rw-r--r-- 1 control control   46 Oct 16 06:13 146d95a7-7788-45b3-8e13-f74d26e33679.sh
（途中省略：同じ形の4つの.shファイル）
drwxr-xr-x 2 control control 4096 Oct 16 06:13 _github_workflow
drwxr-xr-x 2 control control 4096 Oct 16 06:13 _runner_file_commands
```

確認が終わった後、作業用のブランチを削除しました。mainにマージしていないため、手元の削除には`-D`を使います。

**実行コマンド**

```plaintext
cd ~/iac/docker-lab-ci
git switch main
git branch -D gitops14-vault-pass
git push origin --delete gitops14-vault-pass
git branch -a
git status --short; echo "git_status_exit_code=$?"
git log --oneline -1
ls -l ~/.config/ansible-vault
```

**▼ 実行結果**

```plaintext
Switched to branch 'main'
Your branch is up to date with 'origin/main'.
Deleted branch gitops14-vault-pass (was 1d2bf85).
To https://github.com/juehara-crypto/ansible-terraform-ci-lab.git
 - [deleted]         gitops14-vault-pass
* main
  remotes/origin/main
git_status_exit_code=0
cdec03d (HEAD -> main, origin/main) Merge pull request #70 from juehara-crypto/gitops12-ssh-fail
total 4
-rw------- 1 control control 49 Oct 16 01:07 gitops14-vault-pass
```

Secretsの`ANSIBLE_VAULT_PASSWORD`と、手元のVaultパスワードは、この回の以降のセクションでも使うため、残しています。

### ■ 結果

2つの渡し方は、どちらもジョブの中で復号できました。違いは、ジョブの間にVaultパスワードがどこに現れるかです。

|渡し方|ジョブの中で、Vaultパスワードが現れる場所|復号|
|---|---|---|
|A：一時ファイル|環境変数と、`$RUNNER_TEMP`の下のファイル（`-rw-------`）|できた（`"msg": true`）|
|B：スクリプト|環境変数。ファイルには書き出さない|できた（`"msg": true`）|

渡し方Aは、ランナーのホストのディスクに、Vaultパスワードのファイルを作ります。この確認では、同じステップの中で削除し、ステップ「Show files」の時点では、`$RUNNER_TEMP`に`vault-pass-a`はありませんでした。ただし、削除できたのは、削除の行まで処理が進んだからです。途中で止まった場合に、このファイルがどうなるかは、**[セクション3](#3-self-hostedランナーに一時ファイルが残る)** で確かめます。渡し方Bは、ディスクにファイルを作りません。リポジトリに置くスクリプトには、値は含まれていません。

ステップ「Show masking」では、`echo`で値をそのまま出力しても、ログには`value=***`と表示されました。Vaultパスワードは、Secretsに登録した値なので、ジョブのログでは伏せられます。一方、長さ（`length=48`）は伏せられていません。伏せ字が置き換えるのは、Secretsの値と一致する文字列だけです。

もう1つ分かったのは、Vaultパスワードの渡り方です。この確認では、Vaultパスワードをジョブの`env`で渡しました。その結果、ステップ「Run actions/checkout@v4」の環境変数にも`ANSIBLE_VAULT_PASSWORD: ***`が表示され、Vaultパスワードを使わないステップにも渡っていました。**[第13回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part3/ansible-gitops-part3-13/)** のセクション4の棚卸しで、「GitOps Pipeline」と「GitOps Apply」がワークフロー全体の`env`で3つのSecretsを渡し、値が使う場所より広く渡っていたのと同じ形です。この回の以降のセクションでは、Vaultパスワードは、使うステップの`env`だけで渡します。

**[第13回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part3/ansible-gitops-part3-13/)** のセクション4の棚卸しの形で、Vaultパスワードを書き加えると、次のとおりです。

|機密情報|使い道|値がある場所（Gitの外）|渡っている先|
|---|---|---|---|
|Vaultパスワード|暗号化した値を復号する。人が手元で暗号化するときにも使う|GitHubのSecrets、手元の`~/.config/ansible-vault/`|渡し方しだい。この確認では、ジョブの`env`で、チェックアウトを含むすべてのステップ|

Vaultパスワードも、**[第13回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part3/ansible-gitops-part3-13/)** で棚卸しした機密情報と同じく、Gitの外の2か所にあります。入れ替えるときは、その両方を入れ替える必要があります。

また、**[第4回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part1/ansible-gitops-part1-04/)** のセクション6で整理したとおり、この構成では、コードとSecretsをGitHubに預けています。暗号化した値はリポジトリに、それを開くVaultパスワードはSecretsにあるため、暗号文と復号の鍵が、同じ事業者の上にそろうことになります。「Gitに置くが読めなくする」選択肢は、リポジトリを読める人に対しては値を守りますが、外部に預けている範囲そのものは変えません。外部に預ける範囲を狭める設計は、**[第15回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part3/ansible-gitops-part3-15/)** で扱います。

次のセクションでは、渡し方Aのように、Vaultパスワードをファイルに書き出したときに、そのファイルがランナーのホストのどこに、いつまで残るかを確かめます。

---

[↑ 目次に戻る](#-目次)

---

## 3. self-hostedランナーに一時ファイルが残る

**[セクション2](#2-秘密はvaultパスワードに移る)** の渡し方Aのように、Vaultパスワードをファイルに書き出したときに、そのファイルがランナーのホストのどこに、いつまで残るかを、置き場所と、ジョブの終わり方ごとに確かめます。

### 掃除される場所と、されない場所

**[第4回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part1/ansible-gitops-part1-04/)** で整理したとおり、self-hostedランナーは、ホステッドランナーと違い、実行のたびに作り直されません。ジョブが書き出したファイルは、何かが消さない限り、ホストに残ります。

これまでの回で、次のことを確かめています。

* 作業ディレクトリ（チェックアウト先）に置いたファイルは、ジョブが終わっても残り、次の実行のチェックアウトの`git clean -ffdx`で消える。`.gitignore`の対象のファイルも消える（**[第6回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-06/)** のセクション2）
* 作業ディレクトリの外にあるものは、チェックアウトの掃除の対象にならず、実行をまたいで残る（**[第12回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-12/)** のセクション4）
* パイプラインは、書き出した秘密鍵を、`if: always()`を付けたステップでジョブの最後に削除している。ジョブの中のステップが失敗しても、この削除は動く。一方、ジョブの途中でランナーそのものが止まった場合は、このステップが動かず、秘密鍵が残ると考えられる（**[第5回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-05/)**、**[第12回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-12/)** のセクション4。最後の点は導出で、実機では確かめていなかった）

もう1つの置き場所として、**[セクション2](#2-秘密はvaultパスワードに移る)** で使った`$RUNNER_TEMP`があります。GitHubの公式ドキュメント（**[Variables reference](https://docs.github.com/en/actions/reference/workflows-and-actions/variables)**）では、`RUNNER_TEMP`はランナーの一時ディレクトリで、ジョブの始まりと終わりに空にされるとされています。ランナーのユーザーに削除の権限がないファイルは、消されないとも書かれています。

ここでは、この3つの置き場所にVaultパスワードのファイルを書き出し、ジョブが失敗したとき、次の実行のとき、ランナーが途中で止まったときに、それぞれ何が残るかを確かめます。後処理（`if: always()`のステップ）による削除は、わざと置きません。後処理が動かなかった場合に、何が残るかを見るためです。

### ■ 検証内容：ジョブが途中で失敗したとき

まず、ランナーのホストの今の状態を記録します。そのうえで、作業用のブランチに確認用のワークフローを置きます。

**実行コマンド**

```plaintext
cd ~/iac/docker-lab-ci
RUNNER_WS=~/actions-runner/_work/ansible-terraform-ci-lab/ansible-terraform-ci-lab
ls -la ~/actions-runner/_work/_temp
ls -la ~/gitops14-vault-tmp; echo "ls_exit_code=$?"
git -C "$RUNNER_WS" status --short --untracked-files=all; echo "git_status_exit_code=$?"
```

**▼ 実行結果**

```plaintext
total 8
drwxr-xr-x 2 control control 4096 Oct 16 06:13 .
drwxr-xr-x 7 control control 4096 Oct 16 06:13 ..
ls: cannot access '/home/control/gitops14-vault-tmp': No such file or directory
ls_exit_code=2
git_status_exit_code=0
```

`$RUNNER_TEMP`の実体（`~/actions-runner/_work/_temp`）は空でした。**[セクション2](#2-秘密はvaultパスワードに移る)** の「Vault Pass Check」の実行#1のステップ「Show files」の時点では、ランナーが置いた5つの`.sh`がありました。それが、ジョブの終わりに空にされています。

確認用のワークフローは、次のとおりです。Vaultパスワードは、**[セクション2](#2-秘密はvaultパスワードに移る)** の結果のとおり、使うステップの`env`だけで渡します。

* **ファイル名：`.github/workflows/vault-temp-check.yml`**

```yaml
name: Vault Temp Check

on:
  push:
    branches:
      - gitops14-vault-temp

jobs:
  vault-temp:
    runs-on: [self-hosted, Linux, X64]
    steps:
      - uses: actions/checkout@v4
      - name: Write vault password files
        env:
          ANSIBLE_VAULT_PASSWORD: ${{ secrets.ANSIBLE_VAULT_PASSWORD }}
        run: |
          umask 077
          mkdir -p ansible/gitops14-tmp "$HOME/gitops14-vault-tmp"
          for f in ansible/gitops14-tmp/vault-pass "$HOME/gitops14-vault-tmp/vault-pass" "$RUNNER_TEMP/vault-pass"; do
            printf '%s\n' "$ANSIBLE_VAULT_PASSWORD" > "$f"
            ls -l "$f"
          done
      - name: Secret written in run
        env:
          ANSIBLE_VAULT_PASSWORD: ${{ secrets.ANSIBLE_VAULT_PASSWORD }}
        run: |
          echo "inline: ${{ secrets.ANSIBLE_VAULT_PASSWORD }}"
          for f in "$RUNNER_TEMP"/*.sh; do
            echo "mode=$(stat -c '%a' "$f") count=$(grep -cF "$ANSIBLE_VAULT_PASSWORD" "$f") $(basename "$f")"
          done
      - name: Fail on purpose
        run: |
          echo "fail before cleanup"
          exit 1
      - name: Show files
        if: always()
        run: |
          ls -la "$RUNNER_TEMP"
          git status --short --untracked-files=all
```

ステップ「Write vault password files」は、作業ディレクトリの中（`ansible/gitops14-tmp/`）、作業ディレクトリの外（ランナーのユーザーのホームディレクトリの下の`gitops14-vault-tmp/`）、`$RUNNER_TEMP`の3か所に、Vaultパスワードのファイルを書き出します。ステップ「Secret written in run」は、後で扱うため、ここでは説明を省きます。ステップ「Fail on purpose」で、ファイルを消す前にわざと失敗させます。

このワークフローを作業用のブランチ（`gitops14-vault-temp`）にコミットしてプッシュし、「Vault Temp Check」の実行#1が起動しました。実行は、`vault-temp`ジョブの失敗で終わりました。

**▼ 実行結果**（「Vault Temp Check」の実行#1、`vault-temp`ジョブのステップ「Write vault password files」から抜粋）

```plaintext
（途中省略：実行したスクリプト、シェル、環境変数の表示）
-rw------- 1 control control 49 Oct 16 06:42 ansible/gitops14-tmp/vault-pass
-rw------- 1 control control 49 Oct 16 06:42 /home/control/gitops14-vault-tmp/vault-pass
-rw------- 1 control control 49 Oct 16 06:42 /home/control/actions-runner/_work/_temp/vault-pass
```

**▼ 実行結果**（「Vault Temp Check」の実行#1、`vault-temp`ジョブのステップ「Fail on purpose」とステップ「Show files」から抜粋）

```plaintext
（ステップ「Fail on purpose」）
fail before cleanup
Error: Process completed with exit code 1.
（ステップ「Show files」）
（途中省略：実行したスクリプト、シェルの表示）
total 36
drwxr-xr-x 4 control control 4096 Oct 16 06:42 .
drwxr-xr-x 7 control control 4096 Oct 16 06:42 ..
（途中省略：ランナーが置いた4つの.shファイル、_github_workflowと_runner_file_commandsのディレクトリ）
-rw------- 1 control control   49 Oct 16 06:42 vault-pass
?? ansible/gitops14-tmp/vault-pass
```

ジョブが終わった後に、ランナーのホストで確かめます。

**実行コマンド**

```plaintext
RUNNER_WS=~/actions-runner/_work/ansible-terraform-ci-lab/ansible-terraform-ci-lab
echo "== workspace"; ls -la "$RUNNER_WS/ansible/gitops14-tmp" 2>&1
echo "== home"; ls -la ~/gitops14-vault-tmp 2>&1
echo "== runner temp"; ls -la ~/actions-runner/_work/_temp
git -C "$RUNNER_WS" status --short --untracked-files=all
```

**▼ 実行結果**

```plaintext
== workspace
total 12
drwx------ 2 control control 4096 Oct 16 06:42 .
drwxr-xr-x 5 control control 4096 Oct 16 06:42 ..
-rw------- 1 control control   49 Oct 16 06:42 vault-pass
== home
total 12
drwx------  2 control control 4096 Oct 16 06:42 .
drwxr-x--- 15 control control 4096 Oct 16 06:42 ..
-rw-------  1 control control   49 Oct 16 06:42 vault-pass
== runner temp
total 8
drwxr-xr-x 2 control control 4096 Oct 16 06:42 .
drwxr-xr-x 7 control control 4096 Oct 16 06:42 ..
?? ansible/gitops14-tmp/vault-pass
```

### ■ 結果

ジョブが失敗した後、作業ディレクトリの中とホームディレクトリの下には、Vaultパスワードのファイルが残りました。`$RUNNER_TEMP`は空で、書き出したファイルも、ランナーが置いた`.sh`も消えていました。ジョブが失敗で終わっても、`$RUNNER_TEMP`はランナーによって空にされています。

### ■ 検証内容：次の実行のとき

2回目の実行で、1回目の残りものがどうなるかを確かめます。あわせて、3回目でランナーを止めるための準備として、ワークフローを、失敗させる代わりに600秒待つ形に変えます。実行ごとのファイルを区別できるよう、ファイルの名前に実行の番号（`$GITHUB_RUN_NUMBER`）を付けます。

**実行コマンド**

```plaintext
cd ~/iac/docker-lab-ci
cat > .github/workflows/vault-temp-check.yml <<'EOF'
（ワークフローの内容。下の差分のとおり）
EOF
git --no-pager diff
git add .github/workflows/vault-temp-check.yml
git commit -m "GitOps第14回: 一時ファイルの確認を、途中で待つ形に変える"
git push
```

**▼ 実行結果**

```plaintext
diff --git a/.github/workflows/vault-temp-check.yml b/.github/workflows/vault-temp-check.yml
index 6cd2f05..bce8da7 100644
--- a/.github/workflows/vault-temp-check.yml
+++ b/.github/workflows/vault-temp-check.yml
@@ -16,7 +16,7 @@ jobs:
         run: |
           umask 077
           mkdir -p ansible/gitops14-tmp "$HOME/gitops14-vault-tmp"
-          for f in ansible/gitops14-tmp/vault-pass "$HOME/gitops14-vault-tmp/vault-pass" "$RUNNER_TEMP/vault-pass"; do
+          for f in "ansible/gitops14-tmp/vault-pass-$GITHUB_RUN_NUMBER" "$HOME/gitops14-vault-tmp/vault-pass-$GITHUB_RUN_NUMBER" "$RUNNER_TEMP/vault-pass-$GITHUB_RUN_NUMBER"; do
             printf '%s\n' "$ANSIBLE_VAULT_PASSWORD" > "$f"
             ls -l "$f"
           done
@@ -28,10 +28,10 @@ jobs:
           for f in "$RUNNER_TEMP"/*.sh; do
             echo "mode=$(stat -c '%a' "$f") count=$(grep -cF "$ANSIBLE_VAULT_PASSWORD" "$f") $(basename "$f")"
           done
-      - name: Fail on purpose
+      - name: Wait
         run: |
-          echo "fail before cleanup"
-          exit 1
+          echo "waiting from $(date -u '+%Y-%m-%dT%H:%M:%SZ')"
+          sleep 600
       - name: Show files
         if: always()
         run: |
（途中省略：コミットとプッシュの表示）
```

このプッシュで「Vault Temp Check」の実行#2が起動し、成功しました。この実行では、待っている間にランナーを止めることはしていません。

**▼ 実行結果**（「Vault Temp Check」の実行#2、`vault-temp`ジョブのステップ「Run actions/checkout@v4」から抜粋）

```plaintext
（途中省略：入力の表示、Gitのバージョンと設定の表示）
Cleaning the repository
[command]/usr/bin/git clean -ffdx
Removing ansible/gitops14-tmp/
[command]/usr/bin/git reset --hard HEAD
（以下省略）
```

**▼ 実行結果**（「Vault Temp Check」の実行#2、`vault-temp`ジョブのステップ「Write vault password files」とステップ「Wait」から抜粋）

```plaintext
（ステップ「Write vault password files」）
（途中省略：実行したスクリプト、シェル、環境変数の表示）
-rw------- 1 control control 49 Oct 16 06:49 ansible/gitops14-tmp/vault-pass-2
-rw------- 1 control control 49 Oct 16 06:49 /home/control/gitops14-vault-tmp/vault-pass-2
-rw------- 1 control control 49 Oct 16 06:49 /home/control/actions-runner/_work/_temp/vault-pass-2
（ステップ「Wait」）
（途中省略：実行したスクリプト、シェルの表示）
waiting from 2026-10-16T06:49:45Z
```

実行#2が終わった後に、ランナーのホストで確かめます（次の検証のコマンドの前半です）。

**▼ 実行結果**

```plaintext
== before stop 2026-10-16T07:26:00Z
/home/control/actions-runner/_work/ansible-terraform-ci-lab/ansible-terraform-ci-lab/ansible/gitops14-tmp:
total 12
drwx------ 2 control control 4096 Oct 16 06:49 .
drwxr-xr-x 5 control control 4096 Oct 16 06:49 ..
-rw------- 1 control control   49 Oct 16 06:49 vault-pass-2

/home/control/actions-runner/_work/_temp:
total 8
drwxr-xr-x 2 control control 4096 Oct 16 06:59 .
drwxr-xr-x 7 control control 4096 Oct 16 06:49 ..

/home/control/gitops14-vault-tmp:
total 16
drwx------  2 control control 4096 Oct 16 06:49 .
drwxr-x--- 15 control control 4096 Oct 16 06:49 ..
-rw-------  1 control control   49 Oct 16 06:42 vault-pass
-rw-------  1 control control   49 Oct 16 06:49 vault-pass-2
```

### ■ 結果

実行#2のチェックアウトで、1回目の作業ディレクトリの残りもの（`ansible/gitops14-tmp/`）は、`Removing ansible/gitops14-tmp/`として消えました。**[第6回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-06/)** のセクション2と同じ動きです。ただし、消えたのは、次の実行のチェックアウトの時点です。1回目のジョブが終わってから、2回目のチェックアウトまでの間は、Vaultパスワードのファイルが作業ディレクトリに残っていました。

ホームディレクトリの下には、1回目の`vault-pass`と2回目の`vault-pass-2`が、両方残りました。作業ディレクトリの外は、次の実行でも消えず、実行のたびに積み重なります。`$RUNNER_TEMP`は、成功で終わった実行#2の後も、空になっていました。

### ■ 検証内容：ランナーが途中で止まったとき

空のコミットをプッシュして「Vault Temp Check」の実行#3を起動し、ステップ「Wait」で待っている間に、ランナーのサービスを止めます。止める前と止めた後で、ファイルと、ジョブのプロセスを比べます。

**実行コマンド**

```plaintext
RUNNER_WS=~/actions-runner/_work/ansible-terraform-ci-lab/ansible-terraform-ci-lab
SVC=actions.runner.juehara-crypto-ansible-terraform-ci-lab.ubuntu-controller.service
echo "== before stop $(date -u '+%Y-%m-%dT%H:%M:%SZ')"
ls -la "$RUNNER_WS/ansible/gitops14-tmp" ~/gitops14-vault-tmp ~/actions-runner/_work/_temp
ps -ef | grep -E '[R]unner\.(Listener|Worker)|[s]leep 600'
sudo systemctl stop "$SVC"
systemctl is-active "$SVC"; echo "exit_code=$?"
echo "== after stop $(date -u '+%Y-%m-%dT%H:%M:%SZ')"
ls -la "$RUNNER_WS/ansible/gitops14-tmp" ~/gitops14-vault-tmp ~/actions-runner/_work/_temp
ps -ef | grep -E '[R]unner\.(Listener|Worker)|[s]leep 600'; echo "ps_exit_code=$?"
git -C "$RUNNER_WS" status --short --untracked-files=all
```

**▼ 実行結果**

```plaintext
== before stop 2026-10-16T07:35:53Z
/home/control/actions-runner/_work/ansible-terraform-ci-lab/ansible-terraform-ci-lab/ansible/gitops14-tmp:
total 12
drwx------ 2 control control 4096 Oct 16 07:32 .
drwxr-xr-x 5 control control 4096 Oct 16 07:32 ..
-rw------- 1 control control   49 Oct 16 07:32 vault-pass-3

/home/control/actions-runner/_work/_temp:
total 32
drwxr-xr-x 4 control control 4096 Oct 16 07:32 .
drwxr-xr-x 7 control control 4096 Oct 16 07:32 ..
-rw-r--r-- 1 control control  302 Oct 16 07:32 38a7cba9-c4e4-425c-a09f-b1090a7bb640.sh
-rw-r--r-- 1 control control   63 Oct 16 07:32 5d03a2ac-3e53-4de2-8631-adaf179f9ff5.sh
-rw-r--r-- 1 control control  203 Oct 16 07:32 f2ee13d6-9c59-40e4-90a6-3c2067a83481.sh
drwxr-xr-x 2 control control 4096 Oct 16 07:32 _github_workflow
drwxr-xr-x 2 control control 4096 Oct 16 07:32 _runner_file_commands
-rw------- 1 control control   49 Oct 16 07:32 vault-pass-3

/home/control/gitops14-vault-tmp:
total 20
drwx------  2 control control 4096 Oct 16 07:32 .
drwxr-x--- 15 control control 4096 Oct 16 07:32 ..
-rw-------  1 control control   49 Oct 16 06:42 vault-pass
-rw-------  1 control control   49 Oct 16 06:49 vault-pass-2
-rw-------  1 control control   49 Oct 16 07:32 vault-pass-3
control     6590    6575  5 07:32 ?        00:00:11 /home/control/actions-runner/bin/Runner.Listener run --startuptype service
control     6610    6590  6 07:32 ?        00:00:14 /home/control/actions-runner/bin/Runner.Worker spawnclient 149 152
control     6793    6791  0 07:32 ?        00:00:00 sleep 600
inactive
exit_code=3
== after stop 2026-10-16T07:36:12Z
/home/control/actions-runner/_work/ansible-terraform-ci-lab/ansible-terraform-ci-lab/ansible/gitops14-tmp:
total 12
drwx------ 2 control control 4096 Oct 16 07:32 .
drwxr-xr-x 5 control control 4096 Oct 16 07:32 ..
-rw------- 1 control control   49 Oct 16 07:32 vault-pass-3

/home/control/actions-runner/_work/_temp:
total 8
drwxr-xr-x 2 control control 4096 Oct 16 07:36 .
drwxr-xr-x 7 control control 4096 Oct 16 07:32 ..

/home/control/gitops14-vault-tmp:
total 20
drwx------  2 control control 4096 Oct 16 07:32 .
drwxr-x--- 15 control control 4096 Oct 16 07:32 ..
-rw-------  1 control control   49 Oct 16 06:42 vault-pass
-rw-------  1 control control   49 Oct 16 06:49 vault-pass-2
-rw-------  1 control control   49 Oct 16 07:32 vault-pass-3
ps_exit_code=1
?? ansible/gitops14-tmp/vault-pass-3
```

**▼ 実行結果**（「Vault Temp Check」の実行#3、`vault-temp`ジョブのステップ「Wait」から抜粋）

```plaintext
（途中省略：実行したスクリプト、シェルの表示）
waiting from 2026-10-16T07:32:22Z
Error: The runner has received a shutdown signal. This can happen when the runner service is stopped, or a manually started runner is canceled.
Error: The operation was canceled.
Cleaning up orphan processes
Terminate orphan process: pid (6793) (sleep)
（以下省略）
```

実行#3は失敗の扱いになりました。ステップ「Wait」の後のログには、`if: always()`を付けたステップ「Show files」も、チェックアウトの後処理（`Post job cleanup.`）も現れていません。

ランナーを起動し直した後も、ファイルは止めた後と同じでした。GitHubのランナーの画面でも、`ubuntu-controller`は「Idle」に戻りました。

**実行コマンド**

```plaintext
sudo systemctl start "$SVC"
systemctl is-active "$SVC"; echo "exit_code=$?"
sleep 15
ls -la "$RUNNER_WS/ansible/gitops14-tmp" ~/gitops14-vault-tmp ~/actions-runner/_work/_temp
```

**▼ 実行結果**

```plaintext
active
exit_code=0
（途中省略：止めた後と同じファイルの一覧）
```

### ■ 結果

ランナーのサービスを止めると、ランナーは動いていたジョブを取り消し、`sleep`のプロセスを終了させました（`Terminate orphan process`）。`if: always()`のステップは動いていません。**[第12回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-12/)** のセクション4で、導出として残していた「ジョブの途中でランナーが止まると、後処理のステップは動かない」は、少なくともランナーのサービスを止めた場合には、そのとおりでした。

想定と違ったのは、`$RUNNER_TEMP`です。ランナーが途中で止まれば残ると考えていましたが、`systemctl stop`で止めた場合も、`$RUNNER_TEMP`は空になりました（ディレクトリの時刻が07:36）。`$RUNNER_TEMP`を空にするのは、ワークフローのステップではなく、ランナー自身です。サービスを止める操作は、ランナーに終了を知らせる止め方なので、ランナーがジョブを取り消し、`$RUNNER_TEMP`を空にしてから止まったと考えられます。電源断や、プロセスを強制終了したときのように、ランナーが後片付けをする間もなく止まった場合は、この回では確かめていません。その場合でも、公式ドキュメントのとおりであれば、`$RUNNER_TEMP`は次のジョブの始まりに空にされます（この点は、ドキュメントからの導出で、実機では確かめていません）。

3回の実行を並べると、次のとおりです。

|置き場所|ジョブが失敗したとき（実行#1）|ジョブが成功したとき（実行#2）|ランナーを止めたとき（実行#3）|
|---|---|---|---|
|作業ディレクトリの中|残る。次のチェックアウトで消える|残る。次のチェックアウトで消える|残る|
|作業ディレクトリの外（ホームディレクトリの下）|残る|残る。実行のたびに積み重なる|残る|
|`$RUNNER_TEMP`|ジョブの終わりに消える|ジョブの終わりに消える|ジョブの取り消しのときに消えた（サービスを止めた場合）|

### ■ 検証内容：`run:`の中に書いたSecretsの式

3回の実行で、ステップ「Secret written in run」は、`run:`の中に`${{ secrets.ANSIBLE_VAULT_PASSWORD }}`を直接書き、`$RUNNER_TEMP`の`.sh`ファイルに、Vaultパスワードの値が入っているかを数えました。値は表示せず、件数だけを表示しています。

**▼ 実行結果**（「Vault Temp Check」の実行#1、`vault-temp`ジョブのステップ「Secret written in run」から抜粋）

```plaintext
（途中省略：実行したスクリプト、シェル、環境変数の表示）
inline: ***
mode=644 count=1 13401a69-72fb-4646-9314-87380eac6c99.sh
mode=644 count=0 49e1a046-1dc0-4e56-bf3b-1edf30df2eed.sh
```

### ■ 結果

ログには`inline: ***`と、伏せた形で表示されました。一方、`$RUNNER_TEMP`には、ランナーがステップごとに`run:`の中身を書き出した`.sh`ファイルがあり、このステップのファイル（`count=1`）には、Vaultパスワードの値がそのまま入っていました。権限は`644`で、ほかのユーザーからも読める権限です。環境変数で渡した前のステップのファイル（`count=0`）には、値は入っていません。

`run:`の中に`${{ secrets.… }}`を書くと、式は、ステップが動く前に値に置き換えられ、その結果がファイルとしてホストに書き出されます。ログの伏せ字は、表示を隠すだけで、ホストに書き出されるファイルには効きません。このファイルも`$RUNNER_TEMP`にあるため、ジョブの終わりには消えますが、ジョブが動いている間は、ホストの上にあります。Secretsは、`run:`の中に直接書かず、ステップの`env`で環境変数として渡します。

### 後片付け

ホームディレクトリの下と、作業ディレクトリの中に残ったファイルを削除し、作業用のブランチを削除しました。あわせて、ランナーを止めた実行#3では、チェックアウトの後処理が動いていないため、作業ディレクトリの`.git/config`に、チェックアウトが書き込む認証の設定（`http.https://github.com/.extraheader`）が残っていないかを確かめます。値は表示せず、行の数だけを数えます。

**実行コマンド**

```plaintext
cd ~/iac/docker-lab-ci
RUNNER_WS=~/actions-runner/_work/ansible-terraform-ci-lab/ansible-terraform-ci-lab
echo "extraheader_lines=$(git -C "$RUNNER_WS" config --local --get-regexp '^http\..*\.extraheader$' | wc -l)"
git -C "$RUNNER_WS" config --local --unset-all http.https://github.com/.extraheader; echo "unset_exit_code=$?"
echo "extraheader_lines=$(git -C "$RUNNER_WS" config --local --get-regexp '^http\..*\.extraheader$' | wc -l)"
rm -r ~/gitops14-vault-tmp "$RUNNER_WS/ansible/gitops14-tmp"
ls -la ~/gitops14-vault-tmp "$RUNNER_WS/ansible/gitops14-tmp" 2>&1
git -C "$RUNNER_WS" status --short --untracked-files=all; echo "runner_ws_status_exit_code=$?"
git switch main
git branch -D gitops14-vault-temp
git push origin --delete gitops14-vault-temp
git branch -a
git status --short; echo "git_status_exit_code=$?"
git log --oneline -1
```

**▼ 実行結果**

```plaintext
extraheader_lines=1
unset_exit_code=0
extraheader_lines=0
ls: cannot access '/home/control/gitops14-vault-tmp': No such file or directory
ls: cannot access '/home/control/actions-runner/_work/ansible-terraform-ci-lab/ansible-terraform-ci-lab/ansible/gitops14-tmp': No such file or directory
runner_ws_status_exit_code=0
Switched to branch 'main'
Your branch is up to date with 'origin/main'.
Deleted branch gitops14-vault-temp (was 89d746f).
To https://github.com/juehara-crypto/ansible-terraform-ci-lab.git
 - [deleted]         gitops14-vault-temp
* main
  remotes/origin/main
git_status_exit_code=0
cdec03d (HEAD -> main, origin/main) Merge pull request #70 from juehara-crypto/gitops12-ssh-fail
```

`.git/config`には、認証の設定が1行残っていました。チェックアウトは、ジョブのトークンをこの設定に書き込み、ジョブの最後の後処理で消しています。ランナーを止めた実行#3では、その後処理が動かなかったため、残ったと考えられます。ランナーが途中で止まると、Vaultパスワードのファイルだけでなく、ジョブの中で書き込まれた認証の情報も、後処理されないまま残ることになります。このトークンが、ジョブが終わった後も使えるかどうかは、この回では確かめていません。

### 一時ファイルを残さない渡し方

ここまでの結果から、Vaultパスワードをジョブに渡すときの扱いを、次のように決めます。

|方法|この回の扱い|理由|
|---|---|---|
|渡し方B（スクリプト）|採用する|ディスクにファイルを作らない|
|渡し方A（一時ファイル）で、`$RUNNER_TEMP`に置く|ファイルが必要な場合に限る|ランナーが、ジョブの終わりと、サービスを止めたときに空にする|
|渡し方Aで、作業ディレクトリの中に置く|使わない|次のチェックアウトまで残る|
|渡し方Aで、作業ディレクトリの外に置く|使わない|消すものがなく、実行のたびに積み重なる|
|Secretsを`run:`の中に直接書く|使わない|`$RUNNER_TEMP`のステップのスクリプトに、値がそのまま書き込まれる|

`if: always()`の後処理で消す方法は、ジョブの中のステップが失敗したときには動きます。しかし、ランナーそのものが止まったときには動きませんでした。後処理に頼らず、ファイルを作らないか、ランナー自身が空にする場所に置くほうが、残る経路が少なくなります。

この考え方は、Vaultパスワードに限りません。**[第5回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-05/)** から、パイプラインは、Ansibleの接続に使う秘密鍵を、作業ディレクトリの中（今は`ansible/keys/<環境>/`）に書き出し、`if: always()`の後処理で消しています。この回の結果からは、ランナーが途中で止まった場合、その秘密鍵も、次のチェックアウトまで作業ディレクトリに残ることになります（秘密鍵では、実機で確かめていません）。秘密鍵の扱いを含めた、機密情報ごとの置き場所は、**[第15回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part3/ansible-gitops-part3-15/)** で扱います。

この回の以降のセクションでは、Vaultパスワードは、渡し方B（`.github/scripts/vault-pass.sh`）で、使うステップの`env`だけで渡します。

次のセクションでは、Vaultで暗号化した値を変えるプルリクエストで、差分がどう見えるかを、暗号化の単位ごとに確かめます。

---

[↑ 目次に戻る](#-目次)

---

## 4. 暗号化の単位とレビューのしやすさ

Vaultで暗号化した値を1つ変えるプルリクエストで、差分がどう見えるかを、ファイル全体の暗号化と、値ごとの暗号化で比べます。

### コードのレビューで確かめたいこと

**[第7回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-07/)** のセクション7では、プルリクエストのレビューを、「このコードの変更は、mainに入れてよいか」を確かめるチェックポイントとして整理しました。**[第13回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part3/ansible-gitops-part3-13/)** のセクション6で、「Gitに置くが読めなくする」選択肢の利点として挙げたのは、値の変更がコミットとして残り、プルリクエストを通ることでした。この利点が成り立つには、プルリクエストの差分から、何が変わったかを読み取れる必要があります。

**[Ansible×Terraformシリーズ第18回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part2/ansible-terraform-part2-18/)** では、ファイル全体を暗号化すると、1つの値を変えるだけでも、ファイル全体を復号し、編集し、暗号化し直す手順が要り、暗号化したままでは、どの値が変わったのかを差分で追いにくいと整理しました。`encrypt_string`で値ごとに暗号化すれば、変数名は平文のまま残ることも確かめています。ここでは、その差が、プルリクエストの差分にどう現れるかを確かめます。

### ■ 検証内容：同じ値の変更を、2つの単位で比べる

次の2つのファイルを用意します。どちらにも、ダミーの値の変数を2つ置きます。

|ファイル|暗号化の単位|中身|
|---|---|---|
|`ansible/gitops14/vault_file.yml`|ファイル全体（`ansible-vault encrypt`）|`gitops14_db_password`と`gitops14_api_token`|
|`ansible/gitops14/vault_string.yml`|値ごと（`ansible-vault encrypt_string`）|`gitops14_db_password`と`gitops14_api_token`|

最初に、2つのファイルを置いた基準のブランチを作り、その後、`gitops14_api_token`だけを`v1`から`v2`に変えるブランチを作って、プルリクエストで比べます。「GitOps Pipeline」は、mainへのプルリクエストとmainへのプッシュで動くため、プルリクエストの向き先は、mainではなく基準のブランチにします。

ファイル全体を暗号化するときの平文は、リポジトリの外の、本人だけが読める一時ディレクトリ（`mktemp -d`）に置き、暗号化した後すぐに消します。

**実行コマンド**

```plaintext
cd ~/iac/docker-lab-ci
VP=~/.config/ansible-vault/gitops14-vault-pass
git switch -c gitops14-review-base
mkdir -p ansible/gitops14
T=$(mktemp -d)
ls -ld "$T"
printf -- '---\ngitops14_db_password: gitops14-db-v1\ngitops14_api_token: gitops14-api-v1\n' > "$T/plain.yml"
ansible-vault encrypt --vault-password-file "$VP" --output ansible/gitops14/vault_file.yml "$T/plain.yml"
rm -r "$T"
printf -- '---\n' > ansible/gitops14/vault_string.yml
ansible-vault encrypt_string --vault-password-file "$VP" --name gitops14_db_password 'gitops14-db-v1' >> ansible/gitops14/vault_string.yml
ansible-vault encrypt_string --vault-password-file "$VP" --name gitops14_api_token 'gitops14-api-v1' >> ansible/gitops14/vault_string.yml
cat -n ansible/gitops14/vault_file.yml
cat -n ansible/gitops14/vault_string.yml
for f in vault_file vault_string; do echo "== $f"; ansible localhost -i localhost, -c local -m ansible.builtin.debug -a "msg={{ gitops14_db_password == 'gitops14-db-v1' and gitops14_api_token == 'gitops14-api-v1' }}" -e @ansible/gitops14/$f.yml --vault-password-file "$VP" 2>/dev/null | grep '"msg"'; done
git check-ignore -v ansible/gitops14/vault_file.yml ansible/gitops14/vault_string.yml; echo "check_ignore_exit_code=$?"
git add ansible/gitops14/vault_file.yml ansible/gitops14/vault_string.yml
git commit -m "GitOps第14回: 暗号化の単位を比べるためのファイルを追加（v1）"
git push -u origin gitops14-review-base
```

**▼ 実行結果**

```plaintext
Switched to a new branch 'gitops14-review-base'
drwx------ 2 control control 4096 Oct 16 08:17 /tmp/tmp.VxhnSc99SV
Encryption successful
     1  $ANSIBLE_VAULT;1.1;AES256
     2  31363765373832343837633235646337633736343739626465313534303731343461663465633563
     3  6437353637356161353739386538663162616435376232620a636234383437303832313534623531
     4  35663432383532373631336638373864616330616438636661656139663430666633373365336131
     5  3265663962373065330a656465353933303663366234636634633662616362653738313134343137
     6  66313363363232393166303434613533366433326136336233303737336138386562656633373365
     7  30623239386361643237633563373237666164343036343664376332386636366138623364383032
     8  64613630373161376365383038613465636264636633393333313530396561323266616165303862
     9  31373630326336393164
     1  ---
     2  gitops14_db_password: !vault |
     3            $ANSIBLE_VAULT;1.1;AES256
     4            64363433386638326336316439333464353862336131343762346266656332303063366466623765
     5            3531393435373135343161326662613337616634633331640a653862626463303933363334386561
     6            38336635613735306337393333376636306163363439393334663065356330386234323165616439
     7            6533663661616439640a396637373164636433303333363537316639333133373335626362306165
     8            6331
     9  gitops14_api_token: !vault |
    10            $ANSIBLE_VAULT;1.1;AES256
    11            35616665656666313231303335323738336131333931323130373962666134663835303463633135
    12            3035363932633834303262323836373234376631636234370a623832303439306663626464393237
    13            31346531646633643533613431373465346233396231393232306536336562633166616563393565
    14            3039386238656266300a396139633462326363306663346238656533626238306235333662313935
    15            3437
== vault_file
    "msg": true
== vault_string
    "msg": true
check_ignore_exit_code=1
[gitops14-review-base 8636c0f] GitOps第14回: 暗号化の単位を比べるためのファイルを追加（v1）
 2 files changed, 24 insertions(+)
（途中省略：作成の一覧、プッシュの表示）
```

`vault_file.yml`は、1行目のヘッダーの後がすべて暗号文で、変数の名前も見えません。`vault_string.yml`は、変数名の2行が平文で残り、値だけが暗号文になっています。2つのファイルとも、復号した値は想定どおりでした（`"msg": true`）。

続いて、変更のブランチで、`gitops14_api_token`だけを`v2`に変えます。変え方は、それぞれの単位で、ふつうに行う手順にしました。

* `vault_file.yml`：ファイル全体を復号し、1行を書き換えて、ファイル全体を暗号化し直す
* `vault_string.yml`：`gitops14_api_token`の部分だけを消し、新しい値を`encrypt_string`で暗号化して足す。`gitops14_db_password`の部分には触れない

**実行コマンド**

```plaintext
cd ~/iac/docker-lab-ci
VP=~/.config/ansible-vault/gitops14-vault-pass
git switch -c gitops14-review-change
T=$(mktemp -d)
ansible-vault view --vault-password-file "$VP" ansible/gitops14/vault_file.yml > "$T/plain.yml"
sed -i 's/^gitops14_api_token: gitops14-api-v1$/gitops14_api_token: gitops14-api-v2/' "$T/plain.yml"
ansible-vault encrypt --vault-password-file "$VP" --output ansible/gitops14/vault_file.yml "$T/plain.yml"
rm -r "$T"
sed -i '/^gitops14_api_token: !vault |$/,$d' ansible/gitops14/vault_string.yml
ansible-vault encrypt_string --vault-password-file "$VP" --name gitops14_api_token 'gitops14-api-v2' >> ansible/gitops14/vault_string.yml
for f in vault_file vault_string; do echo "== $f"; ansible localhost -i localhost, -c local -m ansible.builtin.debug -a "msg={{ gitops14_db_password == 'gitops14-db-v1' and gitops14_api_token == 'gitops14-api-v2' }}" -e @ansible/gitops14/$f.yml --vault-password-file "$VP" 2>/dev/null | grep '"msg"'; done
git --no-pager diff --stat
git --no-pager diff
git add ansible/gitops14/vault_file.yml ansible/gitops14/vault_string.yml
git commit -m "GitOps第14回: gitops14_api_tokenの値をv2に変える"
git push -u origin gitops14-review-change
```

**▼ 実行結果**

```plaintext
Switched to a new branch 'gitops14-review-change'
Encryption successful
== vault_file
    "msg": true
== vault_string
    "msg": true
 ansible/gitops14/vault_file.yml   | 16 ++++++++--------
 ansible/gitops14/vault_string.yml | 10 +++++-----
 2 files changed, 13 insertions(+), 13 deletions(-)
diff --git a/ansible/gitops14/vault_file.yml b/ansible/gitops14/vault_file.yml
index af200a9..9c7e79a 100644
--- a/ansible/gitops14/vault_file.yml
+++ b/ansible/gitops14/vault_file.yml
@@ -1,9 +1,9 @@
 $ANSIBLE_VAULT;1.1;AES256
-31363765373832343837633235646337633736343739626465313534303731343461663465633563
-6437353637356161353739386538663162616435376232620a636234383437303832313534623531
-35663432383532373631336638373864616330616438636661656139663430666633373365336131
-3265663962373065330a656465353933303663366234636634633662616362653738313134343137
-66313363363232393166303434613533366433326136336233303737336138386562656633373365
-30623239386361643237633563373237666164343036343664376332386636366138623364383032
-64613630373161376365383038613465636264636633393333313530396561323266616165303862
-31373630326336393164
+35323930633034323830666566336366376263306538313931346665666637326531313965313030
+3564613137623662653239393731383537326564626361340a376637656664623938663362653236
+38343533336533363138626636643730613366326234383064383339333366633536306163326138
+6230306634656537340a646435653530343062353333646338633038653366646664663839623136
+39323435366464393333323366633432623136613739333832393238363834316365353337393863
+39643965663833323961623362333164626234623833653161313366323063366461346363643232
+31383534393130636635633666653532633831623563373232666462653334313136373966646466
+37376662313064373537
diff --git a/ansible/gitops14/vault_string.yml b/ansible/gitops14/vault_string.yml
index 7e79b75..536f17b 100644
--- a/ansible/gitops14/vault_string.yml
+++ b/ansible/gitops14/vault_string.yml
@@ -8,8 +8,8 @@ gitops14_db_password: !vault |
           6331
 gitops14_api_token: !vault |
           $ANSIBLE_VAULT;1.1;AES256
-          35616665656666313231303335323738336131333931323130373962666134663835303463633135
-          3035363932633834303262323836373234376631636234370a623832303439306663626464393237
-          31346531646633643533613431373465346233396231393232306536336562633166616563393565
-          3039386238656266300a396139633462326363306663346238656533626238306235333662313935
-          3437
+          61316437663164303238653433393937393934646361616437373838656439306331363465363738
+          3533646130343235613736323132646135636364386137360a643234396134646230396532396361
+          65376137656139643137326136343836316161613763343363616531353333336634383837656237
+          6461336339376430650a306665646633343738616436393537373035393430656435373765336538
+          6537
[gitops14-review-change 6d9ca3d] GitOps第14回: gitops14_api_tokenの値をv2に変える
 2 files changed, 14 insertions(+), 14 deletions(-)
 rewrite ansible/gitops14/vault_file.yml (95%)
（途中省略：プッシュの表示）
```

このブランチから、基準のブランチ`gitops14-review-base`へのプルリクエスト#73を作りました。mainへのプルリクエストではないため、チェックは1つも動いていません。次の画像は、プルリクエスト#73の「Files changed」の画面です。

![プルリクエスト#73のFiles changedの画面。vault_file.ymlは暗号文の8行がすべて追加と削除になっている。vault_string.ymlは、見出しにgitops14_db_passwordの名前が出ているが、入れ替わったのはgitops14_api_tokenの下の暗号文の5行だけになっている](/images/blog/infra/ansible/ansible-gitops/ansible-gitops-part3/ansible-gitops-part3-14/section4-pr-files-changed.png)

確認が終わった後、プルリクエスト#73はマージせずに閉じ、2つのブランチを削除しました。

**実行コマンド**

```plaintext
cd ~/iac/docker-lab-ci
git switch main
git branch -D gitops14-review-change gitops14-review-base
git push origin --delete gitops14-review-change gitops14-review-base
git branch -a
git status --short; echo "git_status_exit_code=$?"
git log --oneline -1
```

**▼ 実行結果**

```plaintext
Switched to branch 'main'
Your branch is up to date with 'origin/main'.
Deleted branch gitops14-review-change (was 6d9ca3d).
Deleted branch gitops14-review-base (was 8636c0f).
To https://github.com/juehara-crypto/ansible-terraform-ci-lab.git
 - [deleted]         gitops14-review-base
 - [deleted]         gitops14-review-change
* main
  remotes/origin/main
git_status_exit_code=0
cdec03d (HEAD -> main, origin/main) Merge pull request #70 from juehara-crypto/gitops12-ssh-fail
```

### ■ 結果

同じ1つの値の変更が、2つのファイルでは、次のように見えました。

|ファイル|差分の大きさ|差分から分かること|差分から分からないこと|
|---|---|---|---|
|`vault_file.yml`（ファイル全体）|8行の削除と8行の追加。コミットの表示は`rewrite (95%)`|ファイルの中身が変わったこと|どの変数が変わったか。変えていない`gitops14_db_password`が変わっていないこと|
|`vault_string.yml`（値ごと）|5行の削除と5行の追加|`gitops14_api_token`の値が変わったこと。`gitops14_db_password`は変わっていないこと|新しい値そのもの|

ファイル全体を暗号化した`vault_file.yml`では、変えたのは1つの変数なのに、ヘッダーを除く暗号文の8行がすべて入れ替わりました。コミットの表示でも、ファイルの書き直し（`rewrite`）として扱われています。変えていない`gitops14_db_password`を含めて、暗号文がまるごと新しくなるため、差分からは、どの変数が変わったのかも、ほかの変数が変わっていないことも読み取れません。レビューする人が確かめられるのは、このファイルが変わったという事実だけです。

値ごとに暗号化した`vault_string.yml`では、入れ替わったのは`gitops14_api_token`の暗号文の5行だけで、`gitops14_db_password`の部分は差分に現れませんでした。変数名の行は平文のまま差分の前後に表示されるため、どの変数の値が変わったかを読み取れます。

ただし、差分の見出しには注意が必要でした。見出しは`@@ -8,8 +8,8 @@ gitops14_db_password: !vault |`で、変えていない`gitops14_db_password`の名前が出ています。見出しには、差分より前にある、字下げのない最後の行が出るためと考えられます。実際に変わった変数は、見出しではなく、差分の前後の行（`gitops14_api_token: !vault |`）を読んで判断する必要があります。

どちらの単位でも、新しい値そのものは、差分には現れません。値を暗号化している以上、これは当然の結果です。レビューで確かめられるのは、「どの秘密の値が変わったか」までで、「新しい値が正しいか」は確かめられません。

GitOpsのパイプラインで、暗号化した値の変更をプルリクエストのレビューに通すなら、値ごとに暗号化する形が向いています。ファイル全体を暗号化すると、プルリクエストを通しても、レビューする人には、変更の中身が何も見えません。**[第13回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part3/ansible-gitops-part3-13/)** で挙げた「値の変更がプルリクエストを通る」という利点は、値ごとに暗号化して初めて、レビューとして意味を持ちます。

一方、レビューの後には、もう1つのチェックポイントがあります。**[第7回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-07/)** で、承認の材料にした`--check --diff`は、復号した値を使って、操作対象に何が書き込まれるかを表示します。レビューでは見えなかった値が、承認の材料では見えることになります。

次のセクションでは、復号した値を使うタスクを`--check --diff`で実行したときに、ジョブのログに何が出るかを確かめます。

---

[↑ 目次に戻る](#-目次)

---

## 5. 復号した値はログと差分に出る

Vaultで暗号化した値を使うタスクを、承認の材料と同じ`--check --diff`で実行したときに、ジョブのログに何が出るかを確かめます。そのうえで、ログに出さないための2つの指定と、それによって承認の材料から何が消えるかを整理します。

### 伏せ字が効くのは、Vaultパスワードだけ

**[セクション2](#2-秘密はvaultパスワードに移る)** で確かめたとおり、Vaultパスワードは、Secretsに登録した値なので、ジョブのログでは`***`に伏せられます。**[第12回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-12/)** のセクション5で確認したとおり、この伏せ字は、Secretsに登録した値と一致する文字列にしか効きません。Vaultパスワードで復号した値は、Secretsに登録した値ではありません。

一方、**[第7回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-07/)** のセクション4では、承認の材料として、確認系の`ansible-playbook`に`--check --diff`を、適用系に`--diff`を付けました。`--diff`は、書き込む内容を差分として表示します。同じ回では、機密の値を配置するタスクでは、その値がログに出るおそれがあるとして、その扱いをこの回に送っています。ここでは、そのおそれを実機で確かめます。

### ■ 検証内容：復号した値を書き込むタスクを、`--check --diff`で実行する

作業用のブランチに、次のファイルを置きます。どれも、この確認のためだけのもので、mainにはマージしません。

|ファイル|内容|
|---|---|
|`ansible/gitops14/vault_secret.yml`|ダミーの値（`gitops14-section5-dummy-token`）を`encrypt_string`で暗号化した変数`gitops14_api_token`|
|`ansible/gitops14/secret_diff.yml`|確認用のPlaybook|
|`.github/scripts/vault-pass.sh`|**[セクション2](#2-秘密はvaultパスワードに移る)** と同じ、Vaultパスワードを出力するスクリプト|
|`.github/workflows/vault-diff-check.yml`|確認用のワークフロー。作業用のブランチへのプッシュでだけ動く|

復号する値は、ログに出ることを確かめるためのダミーの値なので、本文にもそのまま載せます。

確認用のPlaybookは、次のとおりです。

* **ファイル名：`ansible/gitops14/secret_diff.yml`**

```yaml
---
- name: 復号した値の表示を確かめるPlaybook
  hosts: target_nodes
  gather_facts: false
  vars_files:
    - vault_secret.yml
  tasks:
    - name: 秘密を含まない設定ファイル（保護なし）
      become: true
      ansible.builtin.copy:
        dest: /etc/gitops14-app.conf
        content: "app_mode=check\n"
        mode: "0644"

    - name: 秘密を含む設定ファイル（保護なし）
      become: true
      ansible.builtin.copy:
        dest: /etc/gitops14-secret-a.conf
        content: "api_token={{ gitops14_api_token }}\n"
        mode: "0600"

    - name: 秘密を含む設定ファイル（diff false）
      become: true
      diff: false
      ansible.builtin.copy:
        dest: /etc/gitops14-secret-b.conf
        content: "api_token={{ gitops14_api_token }}\n"
        mode: "0600"

    - name: 秘密を含む設定ファイル（no_log true）
      become: true
      no_log: true
      ansible.builtin.copy:
        dest: /etc/gitops14-secret-c.conf
        content: "api_token={{ gitops14_api_token }}\n"
        mode: "0600"
```

4つのタスクは、どれも`copy`で設定ファイルを置くものです。1つ目は、秘密を含まない値を書き込みます。2つ目から4つ目は、復号した`gitops14_api_token`を書き込み、2つ目は何も付けず、3つ目に`diff: false`、4つ目に`no_log: true`を付けています。

確認用のワークフローは、次のとおりです。「GitOps Pipeline」の`ansible-check`と同じく、`terraform init`、鍵の書き出し、`ansible-playbook`、鍵の削除の順に動きます。操作対象は、devの`dev-node1`だけで、確認モードなので、何も書き込みません。Vaultパスワードは、**[セクション3](#3-self-hostedランナーに一時ファイルが残る)** で決めたとおり、スクリプトで渡し、使うステップの`env`だけに置きます。

* **ファイル名：`.github/workflows/vault-diff-check.yml`**

```yaml
name: Vault Diff Check

on:
  push:
    branches:
      - gitops14-vault-diff

jobs:
  vault-diff:
    runs-on: [self-hosted, Linux, X64]
    steps:
      - uses: actions/checkout@v4
      - name: Add Ansible to PATH
        run: echo "$HOME/ansible-env/bin" >> "$GITHUB_PATH"
      - name: Terraform init
        working-directory: terraform/envs/dev
        env:
          PG_CONN_STR: ${{ secrets.PG_CONN_STR }}
        run: terraform init -input=false -lockfile=readonly
      - name: Write private key from tfstate
        working-directory: ansible
        env:
          PG_CONN_STR: ${{ secrets.PG_CONN_STR }}
        run: |
          umask 077
          mkdir -p keys/dev
          terraform -chdir=../terraform/envs/dev output -raw generated_private_key > keys/dev/id_ed25519_generated
      - name: Ansible check mode with diff
        working-directory: ansible
        env:
          PG_CONN_STR: ${{ secrets.PG_CONN_STR }}
          ANSIBLE_VAULT_PASSWORD: ${{ secrets.ANSIBLE_VAULT_PASSWORD }}
        run: ansible-playbook -i inventories/dev gitops14/secret_diff.yml --check --diff --vault-password-file ../.github/scripts/vault-pass.sh
      - name: Remove private key
        if: always()
        working-directory: ansible
        run: rm -f keys/dev/id_ed25519_generated
```

ファイルを作り、手元で構文を確かめてから、プッシュします。`--check --diff`の実行は、ジョブのログで見ます。

**実行コマンド**

```plaintext
cd ~/iac/docker-lab-ci
VP=~/.config/ansible-vault/gitops14-vault-pass
git switch -c gitops14-vault-diff
mkdir -p ansible/gitops14
printf -- '---\n' > ansible/gitops14/vault_secret.yml
ansible-vault encrypt_string --vault-password-file "$VP" --name gitops14_api_token 'gitops14-section5-dummy-token' >> ansible/gitops14/vault_secret.yml
cat > ansible/gitops14/secret_diff.yml <<'EOF'
（Playbookの内容。上のファイルと同じ）
EOF
cat > .github/scripts/vault-pass.sh <<'EOF'
（スクリプトの内容。セクション2と同じ）
EOF
chmod +x .github/scripts/vault-pass.sh
cat > .github/workflows/vault-diff-check.yml <<'EOF'
（ワークフローの内容。上のファイルと同じ）
EOF
cat -n ansible/gitops14/vault_secret.yml
git check-ignore -v ansible/gitops14/vault_secret.yml ansible/gitops14/secret_diff.yml .github/scripts/vault-pass.sh .github/workflows/vault-diff-check.yml; echo "check_ignore_exit_code=$?"
cd ansible
set -a; . ~/.config/tfstate-backend/backend.env; set +a
ansible-playbook -i inventories/dev gitops14/secret_diff.yml --syntax-check --vault-password-file "$VP"; echo "syntax_exit_code=$?"
cd ..
git add ansible/gitops14/vault_secret.yml ansible/gitops14/secret_diff.yml .github/scripts/vault-pass.sh .github/workflows/vault-diff-check.yml
git commit -m "GitOps第14回: 復号した値が--check --diffのログにどう出るかを確かめるワークフローを追加"
git push -u origin gitops14-vault-diff
```

**▼ 実行結果**

```plaintext
Switched to a new branch 'gitops14-vault-diff'
     1  ---
     2  gitops14_api_token: !vault |
     3            $ANSIBLE_VAULT;1.1;AES256
     4            66613832373931373633386330643438306563346363353166656564313537636163623136346265
     5            3537333738313461313233323435393164373766313430340a393431363736333764633961386464
     6            38633534613635323536653064643939343561653563303139306563346537303937636131386465
     7            3166333335323132380a616264383162633530346263353434346435306464613839653133336337
     8            32643365613331613065393437373366363465363637376331616236393830353963
check_ignore_exit_code=1

playbook: gitops14/secret_diff.yml
syntax_exit_code=0
[gitops14-vault-diff 9b1ee38] GitOps第14回: 復号した値が--check --diffのログにどう出るかを確かめるワークフローを追加
 4 files changed, 89 insertions(+)
（途中省略：作成の一覧、プッシュの表示）
```

このプッシュで、「Vault Diff Check」の実行#1が起動し、`vault-diff`ジョブが成功しました。

**▼ 実行結果**（「Vault Diff Check」の実行#1、`vault-diff`ジョブのステップ「Ansible check mode with diff」から抜粋）

```plaintext
（途中省略：実行したスクリプト、シェルの表示）
env:
  PG_CONN_STR: ***
  ANSIBLE_VAULT_PASSWORD: ***

PLAY [復号した値の表示を確かめるPlaybook] **************************************

TASK [秘密を含まない設定ファイル（保護なし）] **********************************
--- before
+++ after: /etc/gitops14-app.conf
@@ -0,0 +1 @@
+app_mode=check

changed: [dev-node1]

TASK [秘密を含む設定ファイル（保護なし）] **************************************
--- before
+++ after: /etc/gitops14-secret-a.conf
@@ -0,0 +1 @@
+api_token=gitops14-section5-dummy-token

changed: [dev-node1]

TASK [秘密を含む設定ファイル（diff false）] ************************************
changed: [dev-node1]

TASK [秘密を含む設定ファイル（no_log true）] ***********************************
changed: [dev-node1]

PLAY RECAP *********************************************************************
dev-node1                  : ok=4    changed=4    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
```

確認が終わった後、ジョブの中で書き出した鍵が消えていること、`dev-node1`に何も書き込まれていないことを確かめ、作業用のブランチを削除しました。

**実行コマンド**

```plaintext
cd ~/iac/docker-lab-ci
RUNNER_WS=~/actions-runner/_work/ansible-terraform-ci-lab/ansible-terraform-ci-lab
ls -la "$RUNNER_WS/ansible/keys/dev" 2>&1
git switch main
git branch -D gitops14-vault-diff
git push origin --delete gitops14-vault-diff
git branch -a
git status --short; echo "git_status_exit_code=$?"
git log --oneline -1
docker exec dev-node1 sh -c 'ls -l /etc/gitops14-* 2>&1'
```

**▼ 実行結果**

```plaintext
total 8
drwx------ 2 control control 4096 Oct 16 09:35 .
drwx------ 3 control control 4096 Oct 16 09:35 ..
Switched to branch 'main'
Your branch is up to date with 'origin/main'.
Deleted branch gitops14-vault-diff (was 9b1ee38).
To https://github.com/juehara-crypto/ansible-terraform-ci-lab.git
 - [deleted]         gitops14-vault-diff
* main
  remotes/origin/main
git_status_exit_code=0
cdec03d (HEAD -> main, origin/main) Merge pull request #70 from juehara-crypto/gitops12-ssh-fail
ls: cannot access '/etc/gitops14-*': No such file or directory
```

### ■ 結果

4つのタスクのログを並べると、次のとおりです。

|タスク|ジョブのログに出たもの|
|---|---|
|秘密を含まない設定ファイル（保護なし）|`+app_mode=check`の差分と、`changed`|
|秘密を含む設定ファイル（保護なし）|`+api_token=gitops14-section5-dummy-token`の差分と、`changed`|
|秘密を含む設定ファイル（`diff: false`）|`changed`だけ|
|秘密を含む設定ファイル（`no_log: true`）|`changed`だけ|

何も付けていないタスクでは、復号した値が、差分の中にそのまま出ました。同じステップの環境変数の表示では、Vaultパスワード（`ANSIBLE_VAULT_PASSWORD: ***`）は伏せられています。しかし、そのVaultパスワードで復号した値は、伏せられていません。Vaultで暗号化して、Vaultパスワードを守っても、`--diff`を付けたジョブのログには、暗号化する前の値がそのまま残ります。

**[第4回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part1/ansible-gitops-part1-04/)** のセクション6で整理したとおり、ジョブのログはGitHubに預けていて、リポジトリを読める人が読めます。**[第13回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part3/ansible-gitops-part3-13/)** のセクション5で整理したとおり、ログは残っている限り読めます。リポジトリの中では暗号文だった値が、ジョブのログでは平文になっていたことになります。

この検証は、確認系と同じ`--check --diff`で行いました。適用系の「GitOps Apply」も、`ansible-playbook`に`--diff`を付けているため、同じタスクを本実行すれば、同じ差分がログに出ると考えられます（適用系での実行は、この回では確かめていません）。「GitOps Pipeline」の`ansible-check`は、プルリクエストの確認でも動くため、マージする前のプルリクエストの時点で、値がログに出ることになります。

`diff: false`を付けたタスクと、`no_log: true`を付けたタスクは、どちらも`changed`だけが出て、差分は出ませんでした。`no_log: true`のタスクでも、出力を隠したことを示す表示はなく、このログからは、2つを見分けられません。2つの違いが現れるのは、`-v`で詳しい出力にしたときや、タスクが失敗したときと考えられます。`no_log: true`は、タスクの結果そのものを隠す指定のため、タスクが失敗したときのエラーの内容も隠れるおそれがあります（どちらも、この回では確かめていません）。**[第12回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-12/)** で整理した、止まったタスクのメッセージから原因を読み取る診断が、そのタスクではできなくなる可能性があります。

そのため、2つの指定は、次のように使い分けます。

|指定|使う場面|
|---|---|
|`diff: false`|秘密の値を、ファイルの中身として書き込むタスク。差分だけを止める|
|`no_log: true`|モジュールの引数や結果そのものに、秘密の値が含まれるタスク|

### 隠すと、承認の材料からも消える

`diff: false`を付けたタスクは、ログに`changed`しか出ませんでした。これは、承認する人が見る材料からも、そのファイルの差分が消えるということです。承認する人に分かるのは、`/etc/gitops14-secret-b.conf`が書き換わることまでで、何が書き込まれるかは分かりません。

**[セクション4](#4-暗号化の単位とレビューのしやすさ)** と合わせると、秘密の値について、2つのチェックポイントで見えるものは、次のとおりです。

|チェックポイント|見えるもの|見えないもの|
|---|---|---|
|プルリクエストのレビュー（値ごとに暗号化）|どの変数の値が変わったか|新しい値そのもの|
|承認の材料（`diff: false`を付けたタスク）|どのファイルが書き換わるか|書き込まれる内容|

レビューのために見せたいものと、漏らさないために隠したいものは、ここでぶつかります。秘密の値は、レビューでも承認でも、値そのものを確かめられません。確かめられるのは、どの値が変わり、どのファイルが書き換わるかまでです。

この衝突の範囲を狭めるには、秘密を含むファイルと、含まないファイルを分けます。この検証の1つ目のタスクのように、秘密を含まない設定ファイルは、何も付けずに差分を出せます。一方、秘密の値を、ほかの設定と同じテンプレートの中に書き込むと、そのファイル全体に`diff: false`を付けることになり、秘密ではない設定の差分まで、承認の材料から消えます。秘密の値だけを別のファイルやタスクに分ければ、`diff: false`で隠れる範囲は、秘密の部分だけで済みます。

新しい値そのものが正しいかは、レビューでも承認でも確かめられないまま残ります。値を入れ替える手順と、入れ替えた値をどう確かめるかは、**[第16回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part3/ansible-gitops-part3-16/)** で扱います。

次のセクションでは、暗号化すべき値を平文のままコミットしてしまった場合に、それをどこで止めればよいかを確かめます。

---

[↑ 目次に戻る](#-目次)

---

## 6. 暗号化し忘れを止めるガードレール

暗号化すべき値を、平文のままコミットしてしまった場合に、それをどこで止めればよいかを、手元のコミットの前と、パイプラインの2か所で確かめます。

### ほかのガードレールと、守る対象が違う

**[第3回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part1/ansible-gitops-part1-03/)** のセクション5では、mainへの直接プッシュを止められない検証環境で、守りたいのはmainに入るコミットではなく、インフラに届く変更だとして、強制する場所を「インフラに適用する前」に移しました。**[第8回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-08/)** と **[第9回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-09/)** のガードレールも、チェックの結果を承認ゲートの入口で確かめ、通らないコミットを適用しない形で組んでいます。

暗号化し忘れは、この考え方では止まりません。守りたいのは、インフラに届く変更ではなく、値そのものだからです。**[第13回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part3/ansible-gitops-part3-13/)** のセクション3で確かめたとおり、平文の値をコミットすると、その値はコミットの履歴に残り、後のコミットで消しても、その前のコミットからは読めます。適用の前に止めても、値はすでに履歴に入っています。暗号化し忘れは、Gitに入る前に止める必要があります。

### 判定の決まり

暗号化し忘れを機械的に見つけるには、どの値を暗号化すべきかが決まっている必要があります。この回では、次の決まりにします。

* 暗号化すべき変数は、名前を`vault_`で始める
* `vault_`で始まる変数の値が、`!vault`（`encrypt_string`の暗号文）でなければ止める
* ファイル全体が暗号化されていれば、そのファイルは通す

### ■ 検証内容：判定のスクリプト

作業用のブランチで、判定のスクリプトを`.github/scripts/`に置きます。止めるときも値は表示せず、ファイル名、行番号、変数名だけを出します。終了コードは、**[第9回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-09/)** の判定のスクリプトにそろえ、`0`が通す、`1`が止める、`2`が使い方の誤りです。

**実行コマンド**

```plaintext
cd ~/iac/docker-lab-ci
git switch -c gitops14-vault-check
cat > .github/scripts/vault-check.sh <<'EOF'
（スクリプトの内容。下のcat -nの結果と同じ）
EOF
chmod +x .github/scripts/vault-check.sh
cat -n .github/scripts/vault-check.sh
bash -n .github/scripts/vault-check.sh; echo "syntax_exit_code=$?"
```

**▼ 実行結果**

```plaintext
Switched to a new branch 'gitops14-vault-check'
     1  #!/usr/bin/env bash
     2  # 名前がvault_で始まる変数の値が、Ansible Vaultで暗号化されているかを確かめる
     3  #   vault-check.sh <YAMLファイル>...
     4  # 終了コード 0=通す、1=止める（暗号化されていない値がある）、2=使い方の誤り
     5  set -euo pipefail
     6  [ $# -ge 1 ] || { echo "usage: vault-check.sh <file>..." >&2; exit 2; }
     7  ng=0
     8  for f in "$@"; do
     9    [ -f "$f" ] || continue
    10    if head -n 1 "$f" | grep -q '^\$ANSIBLE_VAULT;'; then
    11      echo "PASS  $f (file encrypted)"
    12      continue
    13    fi
    14    while IFS=: read -r ln line; do
    15      name=$(printf '%s\n' "$line" | sed -E 's/^[[:space:]]*([A-Za-z0-9_]+)[[:space:]]*:.*/\1/')
    16      if printf '%s\n' "$line" | grep -qE ':[[:space:]]*!vault[[:space:]]*\|'; then
    17        echo "PASS  $f:$ln $name"
    18      else
    19        echo "BLOCK $f:$ln $name is not encrypted"
    20        ng=1
    21      fi
    22    done < <(grep -nE '^[[:space:]]*vault_[A-Za-z0-9_]*[[:space:]]*:' "$f" || true)
    23  done
    24  exit $ng
syntax_exit_code=0
```

10〜13行目で、1行目が`$ANSIBLE_VAULT;`で始まるファイル（ファイル全体の暗号化）を通します。22行目で、`vault_`で始まる変数の行を探し、16行目で、その行の値が`!vault |`かを確かめます。

リポジトリの外の一時ディレクトリに、4種類のファイルを作って確かめます。値は、ダミーの値（`gitops14-section6-dummy`）です。

**実行コマンド**

```plaintext
VP=~/.config/ansible-vault/gitops14-vault-pass
T=$(mktemp -d)
printf -- '---\nvault_db_password: gitops14-section6-dummy\n' > "$T/plain.yml"
ansible-vault encrypt --vault-password-file "$VP" --output "$T/file_encrypted.yml" "$T/plain.yml"
printf -- '---\napp_mode: check\n' > "$T/string_encrypted.yml"
ansible-vault encrypt_string --vault-password-file "$VP" --name vault_db_password 'gitops14-section6-dummy' >> "$T/string_encrypted.yml"
cp "$T/plain.yml" "$T/plaintext.yml"
printf 'app_mode: check\n' > "$T/no_vault_vars.yml"
for f in file_encrypted string_encrypted plaintext no_vault_vars; do echo "== $f"; .github/scripts/vault-check.sh "$T/$f.yml" | sed "s|$T/||"; echo "exit_code=${PIPESTATUS[0]}"; done
.github/scripts/vault-check.sh; echo "exit_code=$?"
rm -r "$T"
```

**▼ 実行結果**

```plaintext
Encryption successful
== file_encrypted
PASS  file_encrypted.yml (file encrypted)
exit_code=0
== string_encrypted
PASS  string_encrypted.yml:3 vault_db_password
exit_code=0
== plaintext
BLOCK plaintext.yml:2 vault_db_password is not encrypted
exit_code=1
== no_vault_vars
exit_code=0
usage: vault-check.sh <file>...
exit_code=2
```

ファイル全体の暗号化と、`encrypt_string`の暗号化は通り（`exit_code=0`）、平文の`vault_db_password`は止まりました（`exit_code=1`）。止めたときも、値は表示されていません。`vault_`で始まる変数がないファイルは、何も表示せずに通り、引数がなければ`exit_code=2`で終わります。

### ■ 検証内容：コミットの前に止める

Gitには、コミットを作る前に動くフック（`pre-commit`）があります。手元のリポジトリの`.git/hooks/pre-commit`に、判定のスクリプトを呼ぶフックを置きます。フックは、コミットしようとしている`ansible/`の下のYAMLファイルについて、作業ツリーではなく、ステージした内容を一時ディレクトリに取り出して確かめます。

確かめるファイル（`ansible/gitops14/vault_vars.yml`）には、`vault_`で始まらない`app_mode`、`encrypt_string`で暗号化した`vault_api_token`、平文のままの`vault_db_password`の3つを置きます。

**実行コマンド**

```plaintext
cd ~/iac/docker-lab-ci
VP=~/.config/ansible-vault/gitops14-vault-pass
cat > .git/hooks/pre-commit <<'EOF'
（フックの内容。下のcat -nの結果と同じ）
EOF
chmod +x .git/hooks/pre-commit
cat -n .git/hooks/pre-commit
mkdir -p ansible/gitops14
printf -- '---\napp_mode: check\n' > ansible/gitops14/vault_vars.yml
ansible-vault encrypt_string --vault-password-file "$VP" --name vault_api_token 'gitops14-section6-api-dummy' >> ansible/gitops14/vault_vars.yml
printf 'vault_db_password: gitops14-section6-dummy\n' >> ansible/gitops14/vault_vars.yml
grep -nE '^[A-Za-z_]+:' ansible/gitops14/vault_vars.yml | cut -d: -f1,2
git add .github/scripts/vault-check.sh ansible/gitops14/vault_vars.yml
git commit -m "GitOps第14回: 暗号化し忘れを含むファイルを追加（フックで止まる確認）"; echo "commit_exit_code=$?"
git log --oneline -1
git status --short
```

**▼ 実行結果**

```plaintext
     1  #!/usr/bin/env bash
     2  # コミットしようとしているansible/のYAMLファイルを、vault-check.shで確かめる
     3  set -euo pipefail
     4  umask 077
     5  repo=$(git rev-parse --show-toplevel)
     6  files=$(git diff --cached --name-only --diff-filter=ACM -- 'ansible/*.yml' 'ansible/*.yaml')
     7  [ -z "$files" ] && exit 0
     8  tmp=$(mktemp -d)
     9  trap 'rm -rf "$tmp"' EXIT
    10  for f in $files; do
    11    mkdir -p "$tmp/$(dirname "$f")"
    12    git show ":$f" > "$tmp/$f"
    13  done
    14  cd "$tmp"
    15  "$repo/.github/scripts/vault-check.sh" $files
2:app_mode
3:vault_api_token
10:vault_db_password
PASS  ansible/gitops14/vault_vars.yml:3 vault_api_token
BLOCK ansible/gitops14/vault_vars.yml:10 vault_db_password is not encrypted
commit_exit_code=1
cdec03d (HEAD -> gitops14-vault-check, origin/main, main) Merge pull request #70 from juehara-crypto/gitops12-ssh-fail
A  .github/scripts/vault-check.sh
A  ansible/gitops14/vault_vars.yml
```

`grep`の行は、ファイルの中の変数名と行番号だけを表示するためのものです。フックは、暗号化した`vault_api_token`を通し、平文の`vault_db_password`で止めました（`commit_exit_code=1`）。コミットは作られず、HEADは`cdec03d`のままで、2つのファイルはステージされたままです。

### ■ 検証内容：フックを外して、パイプラインで止める

フックは、`git commit`の`--no-verify`で外せます。フックを外してコミットし（`f1efdac`）、続けて、判定のスクリプトを動かす確認用のワークフローを足して（`38cbf00`）、プッシュします。

* **ファイル名：`.github/workflows/vault-check.yml`**

```yaml
name: Vault Check

on:
  push:
    branches:
      - gitops14-vault-check

jobs:
  vault-check:
    runs-on: [self-hosted, Linux, X64]
    steps:
      - uses: actions/checkout@v4
      - name: Check vault variables
        run: .github/scripts/vault-check.sh $(git ls-files -- 'ansible/*.yml' 'ansible/*.yaml')
```

プッシュの後に、平文の値を含むコミットがGitHubのブランチにあるかを確かめます。値は表示せず、件数だけを数えます。

**実行コマンド**

```plaintext
cd ~/iac/docker-lab-ci
git commit --no-verify -m "GitOps第14回: 暗号化し忘れを含むファイルを追加（フックを外してコミット）"; echo "commit_exit_code=$?"
cat > .github/workflows/vault-check.yml <<'EOF'
（ワークフローの内容。上のファイルと同じ）
EOF
git add .github/workflows/vault-check.yml
git commit -m "GitOps第14回: 暗号化し忘れを確かめるワークフローを追加"; echo "commit_exit_code=$?"
git push -u origin gitops14-vault-check
git ls-remote origin refs/heads/gitops14-vault-check
git log --oneline -3 origin/gitops14-vault-check
echo "plaintext_count=$(git show origin/gitops14-vault-check~1:ansible/gitops14/vault_vars.yml | grep -cF 'gitops14-section6-dummy')"
```

**▼ 実行結果**

```plaintext
[gitops14-vault-check f1efdac] GitOps第14回: 暗号化し忘れを含むファイルを追加（フックを外してコミット）
 2 files changed, 34 insertions(+)
 create mode 100755 .github/scripts/vault-check.sh
 create mode 100644 ansible/gitops14/vault_vars.yml
commit_exit_code=0
[gitops14-vault-check 38cbf00] GitOps第14回: 暗号化し忘れを確かめるワークフローを追加
 1 file changed, 14 insertions(+)
 create mode 100644 .github/workflows/vault-check.yml
commit_exit_code=0
（途中省略：プッシュの表示）
38cbf00f43f6861d1d6eed97fbbdc10bb71edc31        refs/heads/gitops14-vault-check
38cbf00 (HEAD -> gitops14-vault-check, origin/gitops14-vault-check) GitOps第14回: 暗号化し忘れを確かめるワークフローを追加
f1efdac GitOps第14回: 暗号化し忘れを含むファイルを追加（フックを外してコミット）
cdec03d (origin/main, main) Merge pull request #70 from juehara-crypto/gitops12-ssh-fail
plaintext_count=1
```

`--no-verify`を付けたコミットでは、フックは動かず、平文の値を含むコミットが作られました。ワークフローを足したコミットは、`ansible/`の下のファイルを含まないため、フックを通っています。プッシュの後、GitHubのブランチの先頭は`38cbf00`で、その1つ前のコミットには、平文の値が入っています（`plaintext_count=1`）。

このプッシュで、「Vault Check」の実行#1が起動し、`vault-check`ジョブが失敗しました。

**▼ 実行結果**（「Vault Check」の実行#1、`vault-check`ジョブのステップ「Check vault variables」から抜粋）

```plaintext
（途中省略：実行したスクリプト、シェルの表示）
PASS  ansible/gitops14/vault_vars.yml:3 vault_api_token
BLOCK ansible/gitops14/vault_vars.yml:10 vault_db_password is not encrypted
Error: Process completed with exit code 1.
```

### ■ 検証内容：クローンしたリポジトリ

フックが、リポジトリをクローンした先でも効くかを確かめます。手元のリポジトリを`/tmp`の下にクローンし、平文の`vault_`変数を足してコミットします。このコミットはプッシュせず、クローンごと消します。

**実行コマンド**

```plaintext
cd ~/iac/docker-lab-ci
ls -l .git/hooks/pre-commit
git clone -q ~/iac/docker-lab-ci /tmp/gitops14-clone
cd /tmp/gitops14-clone
git branch --show-current
ls .git/hooks | grep -v '\.sample$'; echo "non_sample_hooks_exit_code=$?"
printf 'vault_extra_password: gitops14-section6-clone-dummy\n' >> ansible/gitops14/vault_vars.yml
git add ansible/gitops14/vault_vars.yml
git -c user.name=gitops14 -c user.email=gitops14@example.com commit -m "GitOps第14回: クローンでの確認用（プッシュしない）"; echo "commit_exit_code=$?"
cd ~/iac/docker-lab-ci
rm -rf /tmp/gitops14-clone
```

**▼ 実行結果**

```plaintext
-rwxrwxr-x 1 control control 493 Oct 16 10:16 .git/hooks/pre-commit
gitops14-vault-check
non_sample_hooks_exit_code=1
[gitops14-vault-check c2771d6] GitOps第14回: クローンでの確認用（プッシュしない）
 1 file changed, 1 insertion(+)
commit_exit_code=0
```

手元のリポジトリにはフックがありますが、クローンした先の`.git/hooks`には、Gitが用意する`.sample`のファイルしかありませんでした（`non_sample_hooks_exit_code=1`）。クローンの側では、平文の`vault_extra_password`を足したコミットが、止まらずに作られています。

### 後片付け

作業用のブランチと、手元のフックを削除しました。

**実行コマンド**

```plaintext
cd ~/iac/docker-lab-ci
git switch main
git branch -D gitops14-vault-check
git push origin --delete gitops14-vault-check
rm .git/hooks/pre-commit
ls .git/hooks | grep -v '\.sample$'; echo "non_sample_hooks_exit_code=$?"
git branch -a
git status --short; echo "git_status_exit_code=$?"
git log --oneline -1
git cat-file -t f1efdac; echo "cat_file_exit_code=$?"
```

**▼ 実行結果**

```plaintext
Switched to branch 'main'
Your branch is up to date with 'origin/main'.
Deleted branch gitops14-vault-check (was 38cbf00).
To https://github.com/juehara-crypto/ansible-terraform-ci-lab.git
 - [deleted]         gitops14-vault-check
non_sample_hooks_exit_code=1
* main
  remotes/origin/main
git_status_exit_code=0
cdec03d (HEAD -> main, origin/main) Merge pull request #70 from juehara-crypto/gitops12-ssh-fail
commit
cat_file_exit_code=0
```

ブランチを削除しても、平文の値を含むコミット`f1efdac`は、手元のリポジトリに残っています（`commit`）。**[第13回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part3/ansible-gitops-part3-13/)** のセクション3で確かめた、どのブランチからもたどれないコミットと同じ状態です。

### ■ 結果

判定を置いた場所ごとに、何が止まり、何が残ったかを並べると、次のとおりです。

|判定を置いた場所|止まったもの|止まらなかったもの・残ったもの|
|---|---|---|
|手元のフック（`pre-commit`）|平文の値を含むコミット|`--no-verify`を付けたコミット。フックを置いていないクローンでのコミット|
|パイプラインのジョブ|ジョブそのもの（失敗）|プッシュした時点で、平文の値はGitHubのブランチにあった。ジョブのチェックアウトで、ランナーの作業ディレクトリにも置かれた|

フックは、平文の値がGitに入る前に止められる、唯一の場所でした。ただし、`--no-verify`で外せ、クローンには付いてきません。Gitは、`.git/hooks`の中身をリポジトリの一部として扱わないため、フックは、クローンした人がそれぞれ置く必要があります。フックをリポジトリの中のディレクトリに置き、`git config core.hooksPath`でそこを指す方法もありますが、この設定もクローンのたびに必要です（この回では確かめていません）。フックは、置いた人の手元でだけ効く、外せるガードレールです。

パイプラインのジョブは、フックを外したコミットも止めました。しかし、ジョブが動くのは、プッシュの後です。止めた時点で、平文の値を含むコミットは、GitHubのブランチにありました。さらに、ジョブのチェックアウトで、そのコミットはランナーの作業ディレクトリにも置かれています。**[第13回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part3/ansible-gitops-part3-13/)** のセクション3で、導出として整理した「ランナーの作業ディレクトリに、機密情報を含むコミットが複製される」経路が、この実行で実際に起きています。

このジョブの結果を、**[第8回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-08/)** や **[第9回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-09/)** と同じ型で、承認ゲートの入口で確かめるようにすれば、平文の値を含むコミットは、インフラには届かなくなります。しかし、その時点では、値はGitHubとランナーにすでに届いています。暗号化し忘れについては、パイプラインのチェックは、止めるためのものではなく、漏れたことに気づくためのものです。

そのため、暗号化し忘れのガードレールは、2段で組みます。

|段|役割|限界|
|---|---|---|
|手元のフック|Gitに入る前に止める|外せる。置いた人の手元でしか効かない|
|パイプラインのチェック|フックをすり抜けたものに気づく|気づいた時点で、値はGitHubとランナーに届いている|

パイプラインのチェックで気づいたときにすべきことは、コミットを取り消すことではなく、漏れた値を入れ替えることです。**[第13回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part3/ansible-gitops-part3-13/)** で確かめたとおり、後のコミットで消しても、値は履歴から読めるためです。漏れた値の入れ替えは、**[第16回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part3/ansible-gitops-part3-16/)** で扱います。

また、この判定は、名前の決まりに頼っています。暗号化すべき値に`vault_`を付け忘れれば、フックもパイプラインも、その値を見つけられません。決まりそのものが守られているかは、プルリクエストのレビューで確かめるしかありません。

次のセクションでは、**[第10回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-10/)** の3つの環境で、Vaultパスワードを環境ごとに分けたときに、何が分けられ、何が分けられないかを確かめます。

---

[↑ 目次に戻る](#-目次)

---

## 7. 環境ごとにVaultパスワードを分ける

**[第10回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-10/)** の3つの環境（dev・stg・prod）で、Vaultパスワードを環境ごとに分けたときに、何が分けられ、何が分けられないかを確かめます。

### 分けられるのは、どのVaultパスワードを渡すかだけ

**[第10回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-10/)** では、tfstate、インベントリ、承認を環境ごとに分けました。**[セクション2](#2-秘密はvaultパスワードに移る)** で整理したとおり、暗号化した値は、Vaultパスワード1つの後ろに集まります。3つの環境の値を1つのVaultパスワードで暗号化すると、devのジョブに渡すVaultパスワードで、prodの値も復号できることになります。

Ansibleには、複数のVaultパスワードを、Vault IDという名前で区別する仕組みがあります。Ansibleの公式ドキュメント（**[Managing vault passwords](https://docs.ansible.com/projects/ansible/latest/vault_guide/vault_managing_passwords.html)**）では、Vault IDを付けて暗号化すると、その名前が暗号文のヘッダーに平文で入るとされています。ただし、その名前は、どのパスワードで暗号化したかの手がかりにすぎず、既定では、Ansibleは渡されたパスワードのどれででも復号を試みる、とも書かれています。

### ■ 検証内容：Vault IDで、環境ごとに暗号化する

手元に、環境ごとのVaultパスワードを3つ作ります。同じ名前の変数`vault_api_token`を、環境ごとのダミーの値と、環境ごとのVaultパスワードで暗号化し、渡すVaultパスワードを変えて、復号できるかを確かめます。暗号化した値は、リポジトリの外の一時ディレクトリに置きます。

**実行コマンド**

```plaintext
VD=~/.config/ansible-vault
for e in dev stg prod; do (umask 077; openssl rand -hex 24 > "$VD/gitops14-vault-pass-$e"); done
ls -l "$VD"
T=$(mktemp -d)
for e in dev stg prod; do printf -- '---\n' > "$T/$e.yml"; ansible-vault encrypt_string --vault-id "$e@$VD/gitops14-vault-pass-$e" --name vault_api_token "gitops14-section7-$e-dummy" >> "$T/$e.yml" 2>/dev/null; done
for e in dev stg prod; do echo "== $e.yml"; sed -n '2,3p' "$T/$e.yml"; done
echo "== dev password only"
for e in dev stg prod; do echo "-- $e.yml"; ansible localhost -i localhost, -c local -m ansible.builtin.debug -a "msg={{ vault_api_token == 'gitops14-section7-$e-dummy' }}" -e @"$T/$e.yml" --vault-id "dev@$VD/gitops14-vault-pass-dev" 2>&1 | grep -E '"msg"|ERROR'; done
echo "== all passwords"
for e in dev stg prod; do echo "-- $e.yml"; ansible localhost -i localhost, -c local -m ansible.builtin.debug -a "msg={{ vault_api_token == 'gitops14-section7-$e-dummy' }}" -e @"$T/$e.yml" --vault-id "dev@$VD/gitops14-vault-pass-dev" --vault-id "stg@$VD/gitops14-vault-pass-stg" --vault-id "prod@$VD/gitops14-vault-pass-prod" 2>&1 | grep -E '"msg"|ERROR'; done
rm -r "$T"
```

**▼ 実行結果**

```plaintext
total 16
-rw------- 1 control control 49 Oct 16 01:07 gitops14-vault-pass
-rw------- 1 control control 49 Oct 16 10:36 gitops14-vault-pass-dev
-rw------- 1 control control 49 Oct 16 10:36 gitops14-vault-pass-prod
-rw------- 1 control control 49 Oct 16 10:36 gitops14-vault-pass-stg
== dev.yml
vault_api_token: !vault |
          $ANSIBLE_VAULT;1.2;AES256;dev
== stg.yml
vault_api_token: !vault |
          $ANSIBLE_VAULT;1.2;AES256;stg
== prod.yml
vault_api_token: !vault |
          $ANSIBLE_VAULT;1.2;AES256;prod
== dev password only
-- dev.yml
    "msg": true
-- stg.yml
    "msg": "Decryption failed (no vault secrets were found that could decrypt)"
-- prod.yml
    "msg": "Decryption failed (no vault secrets were found that could decrypt)"
== all passwords
-- dev.yml
    "msg": true
-- stg.yml
    "msg": true
-- prod.yml
    "msg": true
```

### ■ 結果

Vault IDを付けて暗号化すると、ヘッダーは`$ANSIBLE_VAULT;1.2;AES256;dev`のように、`1.2`と環境の名前になりました。Vault IDを付けなかった **[セクション2](#2-秘密はvaultパスワードに移る)** から **[セクション6](#6-暗号化し忘れを止めるガードレール)** の暗号文は、`1.1`で、名前はありません。

devのVaultパスワードだけを渡すと、devの値は復号でき、stgとprodの値は復号できませんでした。復号できなかったときは、変数を読み込んだ時点ではなく、変数を使ったタスクの失敗（`Decryption failed`）として現れています。3つのVaultパスワードをすべて渡すと、3つとも復号できました。

環境ごとにVaultパスワードを分けても、それだけでは何も分けられません。分離が効くのは、「どのジョブに、どの環境のVaultパスワードを渡すか」を分けたときだけです。

### パイプラインで、環境ごとに渡し分けられるか

**[セクション2](#2-秘密はvaultパスワードに移る)**、**[セクション3](#3-self-hostedランナーに一時ファイルが残る)**、**[セクション5](#5-復号した値はログと差分に出る)** の確認用のワークフローは、どれもmainではない作業用のブランチへのプッシュで動き、リポジトリのSecretsの`ANSIBLE_VAULT_PASSWORD`を受け取っていました。リポジトリのSecretsは、どのブランチのワークフローからも読めます。prodのVaultパスワードをリポジトリのSecretsに置けば、作業用のブランチに置いたワークフローからも読めることになります。

GitHubには、Secretsを環境ごとに分ける仕組みとして、Environmentsがあります。GitHubの公式ドキュメント（**[Deployments and environments](https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments)**）では、Environmentに置いたシークレットは、そのEnvironmentを参照するジョブでだけ使え、Environmentを使えるブランチを規則（Deployment branches and tags）で絞れるとされています。一方、同じドキュメントでは、無料プランでは、Environmentのシークレットは公開リポジトリでしか使えないとされ、ブランチの規則も、非公開リポジトリで使えるプランに無料プランは挙げられていません。また、self-hostedランナーで動くワークフローは、Environmentを使っても分離されたコンテナでは動かないため、Environmentのシークレットも、リポジトリのSecretsと同じ水準で扱うべき、という注記もあります。

この検証環境は、無料プランの非公開リポジトリです。ドキュメントの記述が、実際にどう現れるかを確かめます。

### ■ 検証内容：Environmentのシークレットと、ブランチの規則

GitHubのリポジトリの「Settings」→「Environments」で、確認用のEnvironment`gitops14-check`を作りました。設定の画面には、「Deployment branches and tags」「Environment secrets」「Environment variables」の欄が表示され、承認者を求める設定（Required reviewers）は表示されませんでした。

この画面で、Environmentのシークレット`GITOPS14_ENV_CHECK`（値はダミーの27文字）を登録し、「Deployment branches and tags」で「Selected branches and tags」を選んで、`main`だけを許す規則を追加しました。どちらも保存できました。

![Environment gitops14-checkの設定画面。Deployment branches and tagsにmainの規則が1つ、Environment secretsにGITOPS14_ENV_CHECKが登録されている](/images/blog/infra/ansible/ansible-gitops/ansible-gitops-part3/ansible-gitops-part3-14/section7-environment-settings.png)

画面の上では、ドキュメントで無料プランの非公開リポジトリでは使えないとされていた設定が、どちらもできています。設定できることと、効くことは別なので、ジョブで確かめます。作業用のブランチ`gitops14-env-check`に、Environmentを参照するジョブ（`with-env`）と、参照しないジョブ（`without-env`）を持つ確認用のワークフローを置きます。どちらも、シークレットの値は表示せず、長さだけを表示します。

* **ファイル名：`.github/workflows/env-check.yml`**

```yaml
name: Env Check

on:
  push:
    branches:
      - gitops14-env-check

jobs:
  with-env:
    runs-on: [self-hosted, Linux, X64]
    environment: gitops14-check
    steps:
      - name: Show environment secret length
        env:
          ENV_CHECK: ${{ secrets.GITOPS14_ENV_CHECK }}
        run: echo "length=${#ENV_CHECK}"

  without-env:
    runs-on: [self-hosted, Linux, X64]
    steps:
      - name: Show environment secret length
        env:
          ENV_CHECK: ${{ secrets.GITOPS14_ENV_CHECK }}
        run: echo "length=${#ENV_CHECK}"
```

作業用のブランチは、`main`だけを許す規則に当てはまりません。このワークフローをプッシュし、「Env Check」の実行#1が起動しました。実行は失敗し、`with-env`ジョブは、ログがないまま失敗していました。ジョブの画面には「This job failed」とだけ表示され、理由を示す表示はありませんでした。`without-env`ジョブは成功しました。

**▼ 実行結果**（「Env Check」の実行#1、`without-env`ジョブのステップ「Show environment secret length」から抜粋）

```plaintext
（途中省略：実行したスクリプト、シェルの表示）
env:
  ENV_CHECK: 
length=0
```

続いて、Environmentの規則に`gitops14-env-check`を追加し、規則を`main`と`gitops14-env-check`の2つにしました。そのうえで、実行#1の失敗したジョブをやり直しました（Re-run failed jobs）。

**▼ 実行結果**（「Env Check」の実行#1の2回目の試行、`with-env`ジョブのステップ「Show environment secret length」から抜粋）

```plaintext
（途中省略：実行したスクリプト、シェルの表示）
env:
  ENV_CHECK: ***
length=27
```

確認の後、Environment`gitops14-check`を削除し（登録したシークレットと規則も一緒に消えます）、作業用のブランチと、環境ごとのVaultパスワードのファイルを削除しました。

**実行コマンド**

```plaintext
cd ~/iac/docker-lab-ci
git switch main
git branch -D gitops14-env-check
git push origin --delete gitops14-env-check
rm ~/.config/ansible-vault/gitops14-vault-pass-dev ~/.config/ansible-vault/gitops14-vault-pass-stg ~/.config/ansible-vault/gitops14-vault-pass-prod
ls -l ~/.config/ansible-vault
git branch -a
git status --short; echo "git_status_exit_code=$?"
git log --oneline -1
```

**▼ 実行結果**

```plaintext
Switched to branch 'main'
Your branch is up to date with 'origin/main'.
Deleted branch gitops14-env-check (was 16f878f).
To https://github.com/juehara-crypto/ansible-terraform-ci-lab.git
 - [deleted]         gitops14-env-check
total 4
-rw------- 1 control control 49 Oct 16 01:07 gitops14-vault-pass
* main
  remotes/origin/main
git_status_exit_code=0
cdec03d (HEAD -> main, origin/main) Merge pull request #70 from juehara-crypto/gitops12-ssh-fail
```

### ■ 結果

規則だけを変えて、同じジョブをやり直したところ、`with-env`は動き、Environmentのシークレットを受け取りました（`length=27`）。1回目に`with-env`が止まった理由は、ブランチの規則だったと言えます。Environmentを参照しない`without-env`には、シークレットは渡りませんでした（`length=0`）。

|確かめたこと|ドキュメントの記述|この検証環境での実測|
|---|---|---|
|Environmentのシークレット|無料プランでは、公開リポジトリのみ|登録でき、Environmentを参照するジョブにだけ渡った|
|ブランチの規則（Deployment branches and tags）|非公開リポジトリでは、Pro・Teamのプラン|規則に当てはまらないブランチのジョブは動かず、規則に足すと動いた|

この検証環境では、ドキュメントの記述と違い、どちらも効いていました。**[第3回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part1/ansible-gitops-part1-03/)** のセクション5では、逆に、ブランチ保護のルールが作成できても強制されていませんでした。設定の画面や、プランの名前やドキュメントからは判断せず、自分のリポジトリで効くかを、ジョブを動かして確かめる必要があります。この結果は、今後のプランや仕様の変更で変わる可能性があります。

なお、規則で止められた`with-env`は、ログも理由の表示もないまま、「This job failed」とだけ表示されました。**[第12回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-12/)** で整理した、止まったステップとメッセージから原因を切り分ける診断は、このジョブには使えません。ログのないまま失敗したジョブが、Environmentを参照していれば、Environmentの規則を疑うことになります。

Environmentのシークレットとブランチの規則が効くこの検証環境では、prodのVaultパスワードを、`main`だけを許すEnvironmentのシークレットに置けば、作業用のブランチのワークフローからは読めなくなります。ただし、次の限界が残ります。

|限界|理由|
|---|---|
|mainに直接プッシュしたワークフローからは読める|**[第3回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part1/ansible-gitops-part1-03/)** のセクション5のとおり、この検証環境では、mainへの直接プッシュを止められない|
|ジョブは、どのEnvironmentでも同じホストで動く|ドキュメントの注記のとおり、self-hostedランナーではEnvironmentを使っても分離されない。**[第4回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part1/ansible-gitops-part1-04/)** で整理した信頼の境界は変わらない|
|プルリクエストの確認で、prodの値を復号できなくなる|プルリクエストのワークフローは`refs/pull/<番号>/merge`で動くため、`main`だけを許す規則には当てはまらない（ドキュメントの記述からの導出で、この回では確かめていない）。プルリクエストの段階でprodの`--check --diff`を動かすには、その規則を足す必要があり、そうすると、プルリクエストを作れる人がprodのVaultパスワードを使えるようになる|
|手元には、すべての環境のVaultパスワードがある|値を暗号化する人は、その環境のVaultパスワードを手元に持つ必要がある|

環境ごとにVaultパスワードを分けることで狭められるのは、「どのブランチのジョブが、どの環境の秘密を復号できるか」までです。誰がprodの秘密に触れられるかは、mainに入れられる人と、ランナーのホストに入れる人の範囲で決まり、それは **[第4回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part1/ansible-gitops-part1-04/)** の信頼の境界のままです。

次のセクションでは、この回で確かめた問題が、クラウドのプロバイダーを使う場合にも同じ形で現れることを整理します。

---

[↑ 目次に戻る](#-目次)

---

## 8. クラウドでも3つの問題は同じ

この回で確かめた問題が、TerraformのプロバイダーをAWSやGCPに切り替えたときに、どう現れるかを整理します。クラウドでの実行は行っていないため、ここでは構造を比べるだけにします。

### この回の3つの問題

この回で確かめた問題のうち、パイプラインの構造から生まれるものは、次の3つです。

|問題|この回で確かめたこと|
|---|---|
|秘密がVaultパスワードに移る|暗号化した値は、Vaultパスワード1つの後ろに集まる。Vaultパスワードは、手元とSecretsの2か所に置かれ、暗号文と同じGitHubの上にそろう（**[セクション2](#2-秘密はvaultパスワードに移る)**）|
|ランナーに一時ファイルが残る|Vaultパスワードをファイルに書き出すと、置き場所とジョブの終わり方しだいで、ランナーのホストに残る（**[セクション3](#3-self-hostedランナーに一時ファイルが残る)**）|
|復号した値がログと差分に出る|`--diff`の差分には、復号した値がそのまま出る。隠すと、承認の材料からも消える（**[セクション5](#5-復号した値はログと差分に出る)**）|

暗号化の単位（**[セクション4](#4-暗号化の単位とレビューのしやすさ)**）と、暗号化し忘れ（**[セクション6](#6-暗号化し忘れを止めるガードレール)**）は、GitとAnsible Vaultの性質から生まれる問題で、Terraformのプロバイダーとは関係しません。

### Vaultパスワードの置き場所は、選択肢が増える

**[第5回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-05/)** のセクション8で整理したとおり、クラウドでは、self-hostedランナーをインスタンスと同じVPCの中に置きます。そのランナーには、クラウドの権限（AWSのIAMロールや、GCPのサービスアカウント）を持たせられます。

この構成では、Vaultパスワードを、GitHubのSecretsではなく、クラウドのシークレット管理サービスに置く選択肢が生まれます。**[セクション2](#2-秘密はvaultパスワードに移る)** の渡し方Bのスクリプトを、環境変数ではなく、そのサービスから値を取り出す形に書き換えれば、Ansibleからは同じ`--vault-password-file`で使えます（この回では確かめていません）。暗号文はGitHubに、Vaultパスワードはクラウドの事業者に、と置き場所が分かれるため、**[セクション2](#2-秘密はvaultパスワードに移る)** の結果で見た「暗号文と復号の鍵が、同じ事業者の上にそろう」状態は解けます。

ただし、ジョブがVaultパスワードを受け取って復号する、という構造は変わりません。Vaultパスワードは、ジョブの中で環境変数やプロセスの出力として現れ、そのジョブが動くランナーのホストを通ります。置き場所が変わっても、Vaultパスワードが、ツールを動かすための鍵の1つであることは同じです。どこまでを外部の事業者に預けるかの設計は、**[第15回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part3/ansible-gitops-part3-15/)** で扱います。

### 一時ファイルは、ランナーの作り方で変わる

**[セクション3](#3-self-hostedランナーに一時ファイルが残る)** で、一時ファイルが残ったのは、self-hostedランナーが実行のたびに作り直されないためでした。クラウドでも、VPCの中に置いたself-hostedランナーを使い続けるなら、同じことが起きます。

ランナーを、1つのジョブを動かした後に作り直す形（エフェメラルなランナー）にすれば、ランナーのホストに残る範囲は狭まります（この回では確かめていません）。その場合でも、**[セクション3](#3-self-hostedランナーに一時ファイルが残る)** で確かめた、ジョブが動いている間にホストの上にあるもの（`$RUNNER_TEMP`の一時ファイルや、`run:`の中身を書き出したスクリプト）は変わりません。ファイルを作らない渡し方（渡し方B）と、Secretsを`run:`の中に直接書かないことは、ランナーの作り方に関係なく必要です。

### ログと差分は、プロバイダーと関係しない

**[セクション5](#5-復号した値はログと差分に出る)** で、復号した値をログに出したのは、Ansibleの`--diff`でした。`--diff`が表示する差分は、操作対象がDockerのコンテナでも、AWSやGCPのインスタンスでも、同じ形です。ジョブのログがGitHubに残ることも、プロバイダーとは関係しません。`diff: false`と`no_log: true`の使い分けや、秘密を含むファイルを分ける設計は、プロバイダーを問わずそのまま使えます。

### Terraformの側の秘密は、Vaultの外にある

Ansible Vaultで守れるのは、Ansibleが読む値です。クラウドでは、Terraformのジョブに、クラウドのAPIを呼び出すための認証情報が加わります。**[第13回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part3/ansible-gitops-part3-13/)** で整理したとおり、これは、パイプラインがツールを動かすための鍵で、Ansible Vaultの暗号化の対象にはなりません。また、Terraformに渡した値は、tfstateに残ります。この回で、ユーザーのパスワードのようにTerraformを経由する値をVaultに移さなかったのは、このためです。TerraformとAnsibleの間で、どの秘密をどちらが持つかは、**[第15回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part3/ansible-gitops-part3-15/)** で扱います。

|問題|Docker（本シリーズの検証環境）|AWS・GCP|
|---|---|---|
|Vaultパスワードの置き場所|GitHubのSecretsと手元|クラウドのシークレット管理サービスに置く選択肢が加わる。ジョブが受け取る構造は同じ|
|ランナーに残る一時ファイル|self-hostedランナーのホストに残る|ランナーを使い続ける限り同じ。作り直す形にすれば、残る範囲が狭まる|
|ログと差分に出る値|`--diff`でログに出る|同じ|

プロバイダーを切り替えて変わるのは、Vaultパスワードをどこに預け、ランナーをどう作るかの選択肢です。暗号化した値がVaultパスワードに集まり、ジョブの中で復号され、`--diff`のログに現れる、という構造は、プロバイダーを問わず同じです。

次のセクションでは、この回で確かめた内容をまとめます。

---

[↑ 目次に戻る](#-目次)

---

## 9. まとめ

この回で整理した内容を確認します。

* Ansible Vaultで暗号化した値は、Vaultパスワード1つの後ろに集まる。Vaultパスワードは、値を暗号化する人の手元と、ジョブに渡すためのGitHubのSecretsの2か所に置かれ、暗号文（リポジトリ）と復号の鍵（Secrets）が、同じGitHubの上にそろう。「Gitに置くが読めなくする」選択肢は、リポジトリを読める人に対しては値を守るが、外部に預けている範囲は狭めない
* Vaultパスワードをジョブに渡す方法として、一時ファイルに書き出す方法と、環境変数を出力するスクリプトを`--vault-password-file`に渡す方法を比べ、どちらでも復号できることを実機で確認した。Vaultパスワードはログで`***`に伏せられたが、ジョブ全体の`env`で渡すと、使わないチェックアウトのステップにも渡っていた
* self-hostedランナーでは、Vaultパスワードを書き出したファイルが、作業ディレクトリの中なら次のチェックアウトまで、作業ディレクトリの外なら実行をまたいで残り、`$RUNNER_TEMP`ならジョブの終わりに空にされることを実機で確認した。ランナーのサービスを止めると、`if: always()`の後処理もチェックアウトの後処理も動かず、作業ディレクトリのファイルと、`.git/config`の認証の設定が残った。`run:`の中にSecretsの式を書くと、`$RUNNER_TEMP`に書き出されるステップのスクリプトに、値がそのまま入った。ファイルを作らない、スクリプトによる渡し方を採用した
* 同じ1つの値の変更でも、ファイル全体を暗号化すると、暗号文がすべて入れ替わり、どの変数が変わったかが差分から分からない。`encrypt_string`で値ごとに暗号化すると、変わった変数の暗号文だけが入れ替わり、変数名から何が変わったかを読み取れることを、プルリクエストで確認した。差分の見出しには、変えていない変数の名前が出ることがある。どちらの単位でも、新しい値そのものはレビューできない
* `--check --diff`では、復号した値が、伏せ字にならずにジョブのログにそのまま出ることを実機で確認した。伏せ字が効くのは、Secretsに登録したVaultパスワードだけである。`diff: false`と`no_log: true`を付けたタスクは、どちらも`changed`だけが出て、承認の材料からも書き込む内容が消える。秘密を含むファイルと含まないファイルを分け、隠す範囲を秘密の部分だけに狭める
* 暗号化し忘れは、適用の前に止めても、値はすでに履歴に入っている。`vault_`で始まる変数の値が暗号化されているかを判定するスクリプトを作り、手元のフックでは、平文の値がGitに入る前に止まるが、`--no-verify`で外せ、クローンには付いてこないことを確認した。パイプラインのジョブで止めた時点では、平文の値はGitHubのブランチとランナーの作業ディレクトリにあった。フックで止め、パイプラインで気づく2段で組み、気づいたときは値を入れ替える
* Vault IDで環境ごとにVaultパスワードを分けると、ヘッダーに環境の名前が入るが、分離が効くのは、どのジョブにどの環境のVaultパスワードを渡すかを分けたときだけである。リポジトリのSecretsは、作業用のブランチのワークフローからも読める。この検証環境では、ドキュメントの記述と違い、Environmentのシークレットとブランチの規則が効き、規則に当てはまらないブランチのジョブは、理由の表示なしに失敗した。それでも、mainへの直接プッシュと、同じホストで動くself-hostedランナーという限界は残る
* クラウドでは、Vaultパスワードをクラウドのシークレット管理サービスに置く選択肢や、ランナーをジョブごとに作り直す選択肢が加わるが、暗号化した値がVaultパスワードに集まり、ジョブの中で復号され、`--diff`のログに現れる構造は、プロバイダーを問わず同じである

---

[↑ 目次に戻る](#-目次)

---

## 10. 次回予告

本シリーズの **[第13回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part3/ansible-gitops-part3-13/)** では、第2部で暫定のまま残した機密情報を、パイプラインがツールを動かすための鍵と、操作対象に入れる秘密の値に分けて棚卸しし、機密情報を平文でGitに置かない方法を、「Gitに置かない」と「Gitに置くが読めなくする」の2つに整理しました。第14回となる今回は、後者の選択肢として、Ansible VaultをGitOpsのパイプラインに組み込みました。暗号化した値がVaultパスワードに集まることを確かめ、Vaultパスワードをジョブに渡す方法と、self-hostedランナーに一時ファイルが残る経路を実機で比べました。そのうえで、暗号化の単位によるプルリクエストの差分の違いと、`--check --diff`のログに復号した値が出ることを確かめ、レビューのために見せたいものと、漏らさないために隠したいものの衝突を整理しました。さらに、暗号化し忘れを止める場所を、手元のフックとパイプラインで比べ、環境ごとにVaultパスワードを分けたときの限界と、この構造がクラウドのプロバイダーでも変わらないことを整理しました。

今回は、Ansibleだけが使う秘密の値を対象にし、コンテナのユーザーのパスワードのように、Terraformを経由して渡している値には手を付けませんでした。その値は、今もGitHubのSecretsから、Terraformの変数として渡り、tfstateとイメージの履歴に残っています。また、Vaultパスワードも、GitHubのSecretsに置いたことで、暗号文と同じ事業者の上にそろいました。

次回は、どの秘密をAnsible Vaultで扱い、どの秘密をGitHubのSecretsで扱うかの役割分担を、「その秘密が何と一緒に変わるか」というライフサイクルを基準に確定させます。この回でVaultの外に残した、Terraformを経由する値を、tfstateに残さない形に移し、Ansible Vaultの誤用のパターンを整理します。あわせて、この回で確かめた、Environmentによる分離の限界を踏まえて、無料プランでどこまで分けられるかと、長期間有効な鍵を外部に預けない設計を扱います。

**[次回：第15回：Ansible VaultとGitHub Secretsの役割分担](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part3/ansible-gitops-part3-15/)**

---

📑 連載の移動　**[前の記事：【GitOps編】第13回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part3/ansible-gitops-part3-13/)　｜　[次の記事：【GitOps編】第15回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part3/ansible-gitops-part3-15/)**

---

> **🗺️ 初めての方、シリーズの全体像を知りたい方はこちら**
>
> シリーズ全体については、以下のまとめブログで整理しています。
>
> → **「Ansible×TerraformをGitOpsで回す」〜Terraformプロバイダーを問わない構成管理の自動化〜 第3部まとめブログ：機密情報は「どこに置くか」だけでなく「どこに残るか」で設計する** **※近日公開予定**

---

[↑ 目次に戻る](#-目次)

---

## 11. 連載一覧：「Ansible×TerraformをGitOpsで回す」

### 第3部：GitOpsパイプラインでの機密情報管理

|回数|テーマ、記事タイトル|概要|
|---|---|---|
|**[第13回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part3/ansible-gitops-part3-13/)**|なぜGitリポジトリに機密情報を置いてはいけないのか|「すべてをGitに置く」GitOpsと機密情報の衝突を出発点に、非公開リポジトリでも十分ではない理由をGitの履歴で確かめる。第2部で暫定のまま残した機密情報を2種類に分類して棚卸しし、tfstate・保存したplan・イメージの履歴・ジョブログというGit以外の漏洩経路を実機で示す。Ansible×Terraformシリーズ第18回との接続を示す。第3部の初回。|
|**[第14回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part3/ansible-gitops-part3-14/)**|Ansible VaultをGitOpsパイプラインで安全に扱う|暗号化した値がVaultパスワードに集まることを出発点に、Vaultパスワードの渡し方とself-hostedランナーに残る一時ファイル、暗号化の単位とプルリクエストの差分、`--check --diff`のログに出る復号した値を実機で確かめ、レビューで見せたいものと隠したいものの衝突を整理する。暗号化し忘れを止める場所と、環境ごとにVaultパスワードを分けたときの限界を示す。|
|**[第15回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part3/ansible-gitops-part3-15/)**|Ansible VaultとGitHub Secretsの役割分担|「その秘密が何と一緒に変わるか」というライフサイクルを基準に、「Gitの中はVault、Gitの外は鍵」の役割分担を確定させる。誤用パターン、tfstateに秘密を残さない設計、無料プランでの分離の限界、長期間有効な鍵を外部に預けない設計（OIDC等）も扱う。|
|**[第16回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part3/ansible-gitops-part3-16/)**|Vault情報が漏洩・破損した場合の復旧設計|漏洩と破損を分け、GitHub Secretsが読み出せないこと、Vaultパスワードの変更では過去の暗号文を守れないことを示す。秘密の値そのものの入れ替えをパイプラインに通し、Vault IDで段階的に切り替える。入れ替えのコミットをrevertしてはいけない理由を第11回と接続する。第3部の最終回。|

---

[↑ 目次に戻る](#-目次)

---