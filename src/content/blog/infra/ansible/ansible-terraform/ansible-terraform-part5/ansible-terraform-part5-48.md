---
title: '「AnsibleとTerraformの連携が壊れる理由はライフサイクルにあった」 第48回：イミュータブルインフラストラクチャにおけるAnsibleの限定的役割'
description: '実行時にAnsibleでコンテナ内部を設定する運用を見直し、ビルド時にAnsibleを組み込んでコンテナイメージへ設定を焼き込む運用への転換を整理する。第41回で示した「認識の不可視性」の前提がこの転換によってどう変わるか、第42回・第44回・第47回で確認してきた問題群がどこまで解消されるかを実機で確認する。'
pubDate: 2026-09-17
category: 'infra'
tags: ['Ansible', 'Terraform', 'lifecycle', 'イミュータブルインフラストラクチャ', 'Docker Image']
seriesId: 'ansible-terraform-part5'
seriesNo: 48
prevPost: 'https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part5/ansible-terraform-part5-47/'
nextPost: 'https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part5/ansible-terraform-part5-49/'
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
2. [ビルド時Ansible適用の仕組み](#2-ビルド時ansible適用の仕組み)
3. [実行時構成との役割の違い](#3-実行時構成との役割の違い)
4. [解消される問題と解消されない問題の整理](#4-解消される問題と解消されない問題の整理)
5. [Ansibleの残る役割](#5-ansibleの残る役割)
6. [移行に伴うトレードオフ](#6-移行に伴うトレードオフ)
7. [まとめ](#7-まとめ)
8. [次回予告](#8-次回予告)
9. [連載一覧：「AnsibleとTerraformの連携が壊れる理由はライフサイクルにあった」](#9-連載一覧ansibleとterraformの連携が壊れる理由はライフサイクルにあった)

---

## 1. はじめに

Volumeによるデータの分離さえ導入すれば、Terraformによるリソースの再生成に対してAnsibleが投じた内容は守られる、と考えていないでしょうか。

**[第47回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part5/ansible-terraform-part5-47/)** では、内部データをDocker Volumeに分離し、コンテナが再生成されてもAnsibleの投入データを維持する設計を実機で確認しました。Volumeにマウントした範囲のデータは、コンテナの再生成後も引き継がれることが確認できた一方で、Volume化していない範囲（`sqlite3`パッケージ等）は、これまで通り再生成によって失われることも同時に確認されました。この対策は、実行時にAnsibleで設定変更を加えるという運用そのものを維持したまま、その被害を軽減するアプローチです。

第48回はこれとは異なるアプローチを扱います。実行時にAnsibleで設定変更を加えるという構成そのものを見直し、ビルド時にAnsibleを組み込んでコンテナイメージへ設定を焼き込む運用への転換です。

**[第41回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part5/ansible-terraform-part5-41/)** では、TerraformのState管理が記録する範囲を`terraform show`によって確認し、tfstateがコンテナ内部のOSレイヤーの状態を観測対象に含めていないという構造を「認識の不可視性」として整理しました。この不可視性は、Ansibleが実行時にコンテナ内部を変更するからこそ生じていました。ビルド時に設定を完了させ、コンテナイメージそのものに焼き込んだ場合、Ansibleが変更する対象はコンテナ内部ではなく、イメージのビルドプロセスに変わります。この転換によって、認識の不可視性の前提そのものがどう変わるのかを整理することが、この回の目的です。

この回で扱う問いは、「Ansibleの役割をビルド時に前倒しすると、**[第41回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part5/ansible-terraform-part5-41/)** から **[第47回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part5/ansible-terraform-part5-47/)** で扱ってきた問題はどう変わるのか」です。

次のセクションでは、ビルド時にAnsibleを適用する具体的な仕組みを整理します。

---

[↑ 目次に戻る](#-目次)

---


## 2. ビルド時Ansible適用の仕組み

**[セクション1](#1-はじめに)** で示した転換を、具体的にどう実現するかを整理します。

ビルド時にAnsibleを適用してコンテナイメージへ設定を焼き込む方法として、大きく2通りが考えられます。

* `docker build`のビルドプロセス内でAnsibleを実行する方式
* 一時的に起動したコンテナに対してAnsibleを適用したうえで、`docker commit`によりイメージ化する方式

いずれの方式も、コンテナが実際に稼働を始める前の段階で、Ansibleによる設定投入を完了させ、その結果をイメージそのものに確定させるという点で共通しています。この「起動前にコンテナ内部の状態を確定させる」という一点が、この回で扱う構成の土台になります。
```

【これまでの構成（第1〜47回）】  
ビルド（イメージ作成） → コンテナ起動 → Ansibleが起動後のコンテナに接続して設定投入

【イミュータブル構成（この回）】  
ビルド（イメージ作成、内部でAnsibleを適用） → コンテナ起動（設定投入済みの状態で起動するのみ）

````

この検証環境では、`module.image_ansible_target`によってSSHDのみを含む最小構成のイメージをビルドし、起動後に`null_resource.provision`経由でAnsibleを適用する構成を取ってきました。この回では、`docker build`のビルドプロセス内でAnsibleを実行する方式を選び、既存の`Dockerfile`をもとに新しい`Dockerfile.immutable`を作成します。

### ■ 検証内容：ビルド時実行用Playbookの作成

ビルドコンテキスト（`docker-lab`ディレクトリ）配下に、ビルド時専用のPlaybookを新規作成します。

* **ファイル名：`playbooks_build/immutable_setup.yml`（新規作成）**

```yaml
---
- name: 第48回検証用イミュータブルビルド設定投入Playbook
  hosts: localhost
  connection: local
  gather_facts: false
  become: true

  tasks:
    - name: イミュータブルビルド検証用マーカーファイルを配置
      ansible.builtin.copy:
        dest: /etc/immutable_build_marker.txt
        content: "built_by=ansible(build-time)\n"

    - name: 検証用パッケージをインストール
      ansible.builtin.apt:
        name: tree
        state: present
        update_cache: true
```

**[第42回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part5/ansible-terraform-part5-42/)** の検証で使用したマーカーファイル名（`/etc/lifecycle_test_marker.txt`）とパッケージ（`tree`）に対比できるよう、同じ種類の対象（ファイル1件、パッケージ1件）を、ビルド時専用のファイル名と内容で用意しています。`hosts: localhost`・`connection: local`により、このPlaybookはSSH接続を介さず、実行環境（ビルド中のコンテナ内部）自身に対して直接タスクを適用します。

### ■ 検証内容：`Dockerfile.immutable`の作成

既存の`Dockerfile`をもとに、Ansible本体のインストールと、ビルド時のPlaybook実行を追加します。

* **ファイル名：`Dockerfile.immutable`（新規作成）**

```dockerfile
FROM ubuntu:22.04

# 環境変数とパッケージのインストール（pip経由でAnsible本体を含む）
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y \
    openssh-server \
    python3.10 \
    python3-pip \
    sudo \
    iproute2 \
    curl \
    && rm -rf /var/lib/apt/lists/* \
    && pip install ansible-core==2.17.14

# SSHD の初期設定
RUN mkdir /var/run/sshd

# 検証用ユーザー（ansible）の作成と sudo 権限付与
ARG ANSIBLE_USER_PASSWORD
RUN useradd -m -s /bin/bash ansible && \
    echo "ansible:${ANSIBLE_USER_PASSWORD}" | chpasswd && \
    echo 'ansible ALL=(ALL) NOPASSWD:ALL' >> /etc/sudoers

# SSH公開鍵格納用のディレクトリ作成
RUN mkdir -p /home/ansible/.ssh && \
    chown -R ansible:ansible /home/ansible/.ssh && \
    chmod 700 /home/ansible/.ssh

EXPOSE 22

# ビルド時Ansible適用（第48回）：Playbookをビルドコンテキストからコピーし、ローカル実行で設定を焼き込む
COPY playbooks_build/immutable_setup.yml /tmp/immutable_setup.yml
RUN ansible-playbook /tmp/immutable_setup.yml && rm /tmp/immutable_setup.yml

CMD ["/usr/sbin/sshd", "-D"]
```

既存の`Dockerfile`と比較すると、Ansible本体（`pip install ansible-core==2.17.14`）の追加と、末尾の`COPY`・`RUN ansible-playbook`の2行が新規部分です。`COPY`命令で、ビルドコンテキスト配下の`playbooks_build/immutable_setup.yml`をイメージ内の`/tmp`にコピーし、続く`RUN`命令でこのPlaybookを`ansible-playbook`コマンドとして実行しています。この`RUN`命令が完了した時点で、Ansibleによる設定投入はイメージのレイヤーとして確定します。

### ■ 検証内容：`main.tf`への新規module追加

既存の`module.image_ansible_target`と同じ枠組みで、`Dockerfile.immutable`を使う新しいmoduleを追加します。

* **ファイル名：`main.tf`（該当箇所、新規追加）**

```hcl
# 1-c. 第48回：ビルド時にAnsibleを焼き込むイミュータブル検証用イメージ
module "image_immutable_target" {
  source     = "./modules/ansible_target_image"
  image_name = "ansible-target:immutable"
  dockerfile = "Dockerfile.immutable"
  build_args = {
    ANSIBLE_USER_PASSWORD = var.ansible_user_password
  }
}
```

既存の`module.image_ansible_target`が参照している`./modules/ansible_target_image`モジュールをそのまま流用し、`dockerfile`にのみ`Dockerfile.immutable`を指定しています。この状態で`terraform init`を実行し、新規モジュールが認識されることを確認したうえで、`terraform apply`を実行します。

**実行コマンド**

```plaintext
terraform apply
```

**▼実行結果（該当箇所抜粋）**

```plaintext
Terraform will perform the following actions:

  # module.image_immutable_target.docker_image.this will be created
  + resource "docker_image" "this" {
      + id          = (known after apply)
      + image_id    = (known after apply)
      + name        = "ansible-target:immutable"
      + repo_digest = (known after apply)

      + build {
          # At least one attribute in this block is (or was) sensitive,
          # so its contents will not be displayed.
        }
    }

Plan: 1 to add, 0 to change, 0 to destroy.

（途中省略：yes確認、Still creating...による経過表示）

module.image_immutable_target.docker_image.this: Creation complete after 4m14s [id=sha256:4749a0ce10544993fa48c9ed76b18371ed4cece4ac64692128a7893dace176b0ansible-target:immutable]

Apply complete! Resources: 1 added, 0 changed, 0 destroyed.
```

既存のtarget-node1〜3を含む他のリソースには一切影響がなく、新規イメージのビルドのみが`Plan: 1 to add, 0 to change, 0 to destroy`として計画、実行されました。

### ■ 検証内容：ビルド内部でのAnsible実行ログの確認

`docker_image`リソースによるビルドでは、Terraformの標準出力に`RUN`命令の内部ログが表示されないため、同一の`Dockerfile.immutable`・同一のPlaybookを使い、`docker build`コマンドを直接実行してログを確認します。

**実行コマンド**

```plaintext
docker build -f Dockerfile.immutable --build-arg ANSIBLE_USER_PASSWORD=ansible --progress=plain -t ansible-target:immutable-logcheck . 2>&1 | tee /tmp/immutable_build_log.txt
```

**▼実行結果（該当箇所抜粋）**

```plaintext
#10 [6/7] COPY playbooks_build/immutable_setup.yml /tmp/immutable_setup.yml
#10 DONE 0.3s

#11 [7/7] RUN ansible-playbook /tmp/immutable_setup.yml && rm /tmp/immutable_setup.yml
#11 0.945 [WARNING]: No inventory was parsed, only implicit localhost is available
#11 0.953 [WARNING]: provided hosts list is empty, only localhost is available. Note that
#11 0.953 the implicit localhost does not match 'all'
#11 1.061
#11 1.061 PLAY [第48回検証用イミュータブルビルド設定投入Playbook] ************************
#11 1.061
#11 1.061 TASK [イミュータブルビルド検証用マーカーファイルを配置] ************************
#11 1.983 changed: [localhost]
#11 1.983
#11 1.983 TASK [検証用パッケージをインストール] ******************************************
#11 43.81 changed: [localhost]
#11 43.81
#11 43.81 PLAY RECAP *********************************************************************
#11 43.81 localhost                  : ok=2    changed=2    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
#11 43.81
#11 DONE 44.1s
```

### ■ 結果

`COPY`命令によってPlaybookがイメージ内にコピーされたのち、`RUN ansible-playbook`が実行され、`PLAY [第48回検証用イミュータブルビルド設定投入Playbook]`から`PLAY RECAP`までの一連の実行過程が、ビルドプロセスの内側（`#11`のステップ）でそのまま出力されています。`ok=2 changed=2`となっており、マーカーファイルの配置と`tree`パッケージのインストールの両タスクが、コンテナが起動する前の段階で完了していることが確認できました。

セクション1で示した通り、これまでの構成ではAnsibleの実行ログは、起動済みのコンテナに対する`null_resource.provision`のプロビジョナー出力として現れていました。今回の実行ログは、それとは異なり、`docker build`のビルドステップの一部として現れています。Ansibleが処理を行うタイミングそのものが、コンテナの起動後からビルドの内部へ移ったことが、このログの現れ方の違いからも確認できます。

次のセクションでは、この構成が、これまでの実行時構成とどう役割が異なるかを整理します。


---

[↑ 目次に戻る](#-目次)

---

## 3. 実行時構成との役割の違い

**[セクション2](#2-ビルド時ansible適用の仕組み)** で確認したビルド時適用が、これまでの実行時構成とどう役割が異なるかを整理します。

これまでの構成（**[第1回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part1/ansible-terraform-part1-01/)**から **[第47回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part5/ansible-terraform-part5-47/)**）では、Ansibleが対象にしていたのは「起動後のコンテナ」でした。**[第41回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part5/ansible-terraform-part5-41/)** で確認した通り、`null_resource.provision`は`docker_container.targets`の作成が完了したあとに`local-exec`でAnsibleを実行し、target-node1〜3というすでに起動しているコンテナへSSH接続して設定を投入していました。この構成では、Terraformが扱う`docker_container`はあくまで「Ansibleが後から接続する先」であり、コンテナが起動した時点ではまだ設定は完了していません。

【これまでの構成（第1〜47回）】
terraform apply → コンテナ起動（未設定） → Ansibleが起動後のコンテナに接続して設定投入 → 設定完了


一方、この回の構成では、Ansibleが対象にするのは「イメージビルドプロセス」そのものです。**[セクション2](#2-ビルド時ansible適用の仕組み)** で確認した通り、`Dockerfile.immutable`内の`RUN ansible-playbook`は、コンテナが起動するよりも前、イメージのビルド段階で実行されます。この時点でAnsibleによる設定投入はイメージのレイヤーとして確定しており、`docker_container.targets`に相当するリソースが実際にコンテナとして起動する頃には、設定はすでに完了しています。

【イミュータブル構成（この回）】
docker build（内部でAnsible実行、設定確定） → terraform apply → コンテナ起動（設定済み） → 起動後にAnsibleが介入する余地なし


この違いを、実機で直接確認します。

### ■ 検証内容：ビルド済みイメージからの起動確認

**[セクション2](#2-ビルド時ansible適用の仕組み)** で作成した`ansible-target:immutable`イメージから、検証用コンテナ（`docker_container.immutable_verify`）を新規に作成します。このコンテナは、target-node1〜3を対象にした`null_resource.provision`の対象には含まれておらず、Ansibleを一度も実行していません。

* **ファイル名：`main.tf`（該当箇所、新規追加）**

```hcl
# 1-d. 第48回：ビルド済みイメージの起動確認用コンテナ（target-node1〜3とは独立）
resource "docker_container" "immutable_verify" {
  name    = "immutable-verify-node"
  image   = module.image_immutable_target.image_id
  command = ["/usr/sbin/sshd", "-D"]
}
```

**実行コマンド**

```plaintext
terraform apply
```

**▼実行結果（該当箇所抜粋）**

```plaintext
Terraform will perform the following actions:

  # docker_container.immutable_verify will be created
  + resource "docker_container" "immutable_verify" {
      + image                                       = "sha256:4749a0ce10544993fa48c9ed76b18371ed4cece4ac64692128a7893dace176b0"
      + name                                        = "immutable-verify-node"
        # (以下略：known after applyの属性群)
    }

Plan: 1 to add, 0 to change, 0 to destroy.

（途中省略：yes確認）

docker_container.immutable_verify: Creating...
docker_container.immutable_verify: Creation complete after 1s [id=1ba635c397faee31646ff9a7ba4126b2deb3a92509a6f006b7c69a9fb5b67671]

Apply complete! Resources: 1 added, 0 changed, 0 destroyed.
```

コンテナが起動した直後、Ansibleを一切実行せずに、内部の状態を確認します。

**実行コマンド**

```plaintext
docker exec -it immutable-verify-node bash -c "cat /etc/immutable_build_marker.txt"
docker exec -it immutable-verify-node bash -c "which tree && tree --version"
```

**▼実行結果**

```plaintext
built_by=ansible(build-time)
/usr/bin/tree
tree v2.0.2 (c) 1996 - 2022 by Steve Baker, Thomas Moore, Francesc Rocher, Florian Sesser, Kyosuke Tokoro
```

### ■ 結果

`immutable-verify-node`には、起動後に一度もAnsibleを実行していないにもかかわらず、マーカーファイル（`/etc/immutable_build_marker.txt`）とパッケージ（`tree`）がすでに存在しています。`docker exec`で確認したこれらの状態は、**[セクション2](#2-ビルド時ansible適用の仕組み)** のビルド時に投入された内容そのままです。

これまでの構成であれば、コンテナが起動した直後の状態はSSHDのみが動く最小限のものであり、Ansibleが接続して初めてこの2つが揃います。今回のコンテナには、その「接続して設定する」という工程そのものが一度も発生していません。この対比から、Terraformが扱う`docker_container`は、この構成ではビルド済みイメージから起動するだけの存在になっており、起動後にAnsibleが介入する余地がなくなっていることが実機で確認できました。

次のセクションでは、この転換によって、**[第41回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part5/ansible-terraform-part5-41/)** から **[第47回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part5/ansible-terraform-part5-47/)** で扱ってきた問題群がどこまで解消されるのかを整理します。

---

[↑ 目次に戻る](#-目次)

---


## 4. 解消される問題と解消されない問題の整理

この回の中心となる整理です。ビルド時への転換によって、**[第41回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part5/ansible-terraform-part5-41/)** から **[第47回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part5/ansible-terraform-part5-47/)** で扱ってきた問題群のうち、どこまでが解消され、どこからが解消されないのかを整理します。

| 回                                                                                                                                                                                                                                                                           | 問題            | イミュータブル化による変化              |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- | -------------------------- |
| **[第42回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part5/ansible-terraform-part5-42/)**                                                                                                                                       | 強制再生成による設定消失  | 実質的に解消（設定はイメージに含まれる）       |
| **[第44回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part5/ansible-terraform-part5-44/)**・**[第47回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part5/ansible-terraform-part5-47/)** | ステートフルなデータの消失 | 影響を受けない（Volume等の設計が引き続き必要） |

### ■ 第42回との対比：強制再生成による設定消失

**[第42回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part5/ansible-terraform-part5-42/)** では、`name`属性の変更のような、`lifecycle`ブロックを使わない素の再生成によって、Ansibleが投じたファイル（`/etc/lifecycle_test_marker.txt`）とパッケージ（`tree`）の両方が失われることを確認しました。この消失は、**[第41回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part5/ansible-terraform-part5-41/)** で整理した「認識の不可視性」、つまりtfstateがコンテナ内部のOSレイヤーの状態を観測対象に含めていないという構造から導かれる帰結でした。

**[セクション3](#3-実行時構成との役割の違い)** で確認した通り、ビルド時に設定を焼き込んだ`immutable-verify-node`に対し、**[第42回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part5/ansible-terraform-part5-42/)** と同じ`name`属性の変更による再生成を発生させたところ、マーカーファイル（`/etc/immutable_build_marker.txt`）と`tree`パッケージのどちらも、再生成後のコンテナに引き継がれていました。

この結果の違いは、焼き込まれた設定がどのリソースに属しているかという点から説明できます。**[第42回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part5/ansible-terraform-part5-42/)** で失われた設定は、Ansibleが実行時にコンテナ内部（tfstateの観測範囲外）へ投じたものであり、コンテナという1つのリソースの内部にしか存在していませんでした。一方、この回で焼き込んだ設定は、`docker_image.this`というコンテナとは別の独立したリソースの中に確定しています。**[第47回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part5/ansible-terraform-part5-47/)** の`docker_volume`がコンテナの再生成に巻き込まれず存続したのと同じように、`docker_image.this`もコンテナの破棄、再生成の対象には含まれません。**[セクション3](#3-実行時構成との役割の違い)** の`terraform plan`結果でも、再生成の対象は`docker_container.immutable_verify`のみであり、イメージ本体は一切変更対象になっていませんでした。新しいコンテナは、`image = module.image_immutable_target.image_id`という参照を通じて、この存続したイメージをそのまま使って作られています。
```

【第42回：実行時に投じた設定】  
設定はコンテナという1つのリソースの内部にのみ存在  
　→ コンテナが再生成されると、設定も一緒に失われる

【第48回：ビルド時に焼き込んだ設定】  
設定はdocker_imageというコンテナとは別の独立したリソースの中に確定  
　→ コンテナが再生成されても、イメージ自体は存続し、新しいコンテナが再度参照する

```

したがって、`lifecycle`ブロックによる強制再生成のような、**[第42回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part5/ansible-terraform-part5-42/)** で確認した設定消失は、ビルド時への転換によって実質的に解消されるといえます。ただしこれは、Terraformが焼き込まれた設定を何らかの形で保護しているためではなく、設定の器そのものが、コンテナとは別のライフサイクルを持つリソースに移ったことの結果です。

### ■ 第44回・第47回との対比：ステートフルなデータの消失

一方、**[第44回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part5/ansible-terraform-part5-44/)** ・**[第47回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part5/ansible-terraform-part5-47/)** で扱った問題は、この転換によっても影響を受けません。

**[第47回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part5/ansible-terraform-part5-47/)** で整理した通り、Volumeによる保護は自動的な万能策ではなく、明示的にマウントした範囲に限られます。ビルド時への転換は、あくまでイメージという静的な成果物に設定を確定させる仕組みであり、稼働後に増え続けるデータをどう扱うかという課題には関与しません。データはビルド時点では未生成であり、そもそも焼き込む対象として存在しないためです。
```

【ビルド時に確定できるもの】  
設定ファイル、パッケージ導入等の静的な設定  
　→ ビルド時にイメージへ焼き込み、docker_imageという独立したリソースとして再生成を通過できる

【ビルド時に確定できないもの】  
稼働後に生成され続けるデータ（データベースのレコード等）  
　→ イメージには含まれず、Volume等の別の仕組みで保護する必要がある

```

したがって、この検証環境でイミュータブル運用へ転換した場合も、**[第47回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part5/ansible-terraform-part5-47/)** で導入した`docker_volume.target_node1_data`のようなデータ永続化の設計は、引き続き必要になります。

### ■ 結果

イミュータブル運用への転換は、Ansibleが投じる対象を「起動後のコンテナ内部」から「ビルド時のイメージ」に移すことで、設定の器をコンテナとは別の独立したリソース（`docker_image`）に移す効果を持ちます。この効果が及ぶのは、ビルド時点で内容が確定できる静的な設定に限られ、稼働後に生成され続けるデータには及びません。次のセクションでは、この転換によってもAnsible自体が不要にならない理由を整理します。

---

[↑ 目次に戻る](#-目次)

---


## 5. Ansibleの残る役割

イミュータブル運用への転換によって、Ansibleそのものが不要になるわけではないことを整理します。

**[セクション2](#2-ビルド時ansible適用の仕組み)** から **[セクション4](#4-解消される問題と解消されない問題の整理)** で見てきた転換は、あくまでAnsibleを実行するタイミングを「コンテナ起動後」から「イメージビルド時」に移したものです。**[セクション2](#2-ビルド時ansible適用の仕組み)** で新規作成した`playbooks_build/immutable_setup.yml`は、これまでのPlaybook（`site.yml`、`roles/common`等）と同様に、`ansible.builtin.copy`や`ansible.builtin.apt`といった通常のAnsibleモジュールで構成されています。Playbookそのものの書き方や、モジュールの選び方に、イミュータブル運用特有の制約が新たに生じているわけではありません。
```

【これまでの構成】  
Playbookの実行対象：起動中の本番コンテナ（target-node1〜3）  
実行方法：SSH経由、null_resource.provisionのlocal-exec

【イミュータブル構成（この回）】  
Playbookの実行対象：イメージビルド用の一時的な環境（ビルド中のコンテナ）  
実行方法：connection: localによるローカル実行、Dockerfile内のRUN命令

```

変わったのは実行対象と実行方法であり、Ansibleというツールの役割そのものではありません。Ansibleは、OS、パッケージ、ファイル、サービス等の構成を手続き的に管理するツールです。この管理対象自体は、それがビルド中の一時的な環境であっても、稼働中の本番コンテナであっても変わりません。

この点は、Playbookの設計原則にも及びます。冪等性シリーズで扱ってきた「同じPlaybookを何度実行しても同じ結果になる」という冪等性の考え方は、ビルド時の実行であっても引き続き重要です。**[セクション2](#2-ビルド時ansible適用の仕組み)** の`immutable_setup.yml`で使用した`ansible.builtin.apt`（`state: present`）は、パッケージが既に存在する場合は`changed`にならず、何度実行しても同じ状態に収束するモジュールです。イメージのビルドは、開発中に何度もやり直される作業であり、その都度Playbookが再実行されます。ビルド専用の一時的な環境で実行されるからといって、非冪等なタスク（`shell`モジュールでの直接操作等）を安易に持ち込んでよいことにはなりません。

したがって、イミュータブル運用への移行は、「Ansibleを使わない」という選択ではなく、「Ansibleを使うタイミングを変える」という選択です。Playbookの実行対象が本番コンテナから一時的なビルド環境に変わっても、Ansible自体の設計上の配慮（冪等性の確保、モジュールの選定）が不要になるわけではありません。

次のセクションでは、この転換が万能な解決策ではないことを、トレードオフの観点から整理します。

---

[↑ 目次に戻る](#-目次)

---



## 6. 移行に伴うトレードオフ

この転換が万能な解決策ではないことを整理します。

**[セクション4](#4-解消される問題と解消されない問題の整理)** で確認した通り、ビルド時への転換によって、`lifecycle`ブロックによる強制再生成のような設定消失は実質的に解消されます。しかし、この解決には見合った負担が伴います。

これまでの構成（**[第1回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part1/ansible-terraform-part1-01/)** から **[第47回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part5/ansible-terraform-part5-47/)** ）では、target-node1〜3のAnsible設定を変更したい場合、Playbookを書き換えて`ansible-playbook`を再実行するだけで、既存のコンテナに対してその変更を直接適用できました。コンテナ自体を作り直す必要はありません。

一方、イミュータブル運用に転換した場合、設定の変更手順は以下のようになります。
```

【これまでの構成】  
Playbook変更 → ansible-playbook再実行 → 既存コンテナに直接反映

【イミュータブル構成（この回）】  
Playbook変更 → イメージの再ビルド → 新しいイメージからコンテナを再作成 → 反映

```

**[セクション2](#2-ビルド時ansible適用の仕組み)** で確認した通り、`docker build`のビルド自体にも一定の時間がかかります（今回の検証では、Ansible実行部分だけで40秒以上を要しました）。ちょっとした設定変更のたびに、イメージのビルドから始める必要があり、これまでのようにPlaybookの再実行だけでは完結しません。

この検証環境では、`terraform apply`によってビルドとコンテナの再作成を手動で順に行いましたが、実際の運用でこのサイクルを人手で繰り返すのは現実的ではありません。イメージのビルド、レジストリへの登録、新しいイメージを使ったコンテナの再作成という一連の流れを自動化するには、CI/CDパイプラインの整備が前提になりやすくなります。
```

【メリット】  
起動後にAnsibleが介入しないため、**[第42回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part5/ansible-terraform-part5-42/)** のような設定消失は起きない

【トレードオフ】  
設定変更のたびにイメージの再ビルド、再デプロイが必要になる  
　→ CI/CDパイプラインの整備が前提になる

```

**[第31回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part4/ansible-terraform-part4-31/)** ・**[第32回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part4/ansible-terraform-part4-32/)** で扱った通り、この検証環境には既に`terraform output`を介した疎結合なパイプライン設計や、GitHub Actionsを用いたE2E自動化の土台があります。イミュータブル運用への転換は、これらの自動化の仕組みを前提にして初めて、日常的な設定変更のサイクルとして成立します。この転換は、**[第41回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part5/ansible-terraform-part5-41/)** から **[第47回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part5/ansible-terraform-part5-47/)** で扱ってきた問題を回避する代わりに、ビルドサイクルという新しい運用コストを持ち込むものであり、問題そのものを消し去るわけではありません。

次のセクションでは、この回で整理した内容をまとめます。



---

[↑ 目次に戻る](#-目次)

---

## 7. まとめ

この回で整理した内容を確認します。

* ビルド時にAnsibleを適用してイメージに焼き込むことで、起動後のコンテナに対してAnsibleが介入しない構成に転換できることを、`docker build`のビルドプロセス内でAnsibleを実行する方式により実機で確認した
* ビルド済みイメージから起動したコンテナに対し、一度もAnsibleを実行していないにもかかわらず、マーカーファイル（`/etc/immutable_build_marker.txt`）とパッケージ（`tree`）がすでに存在していることを実機で確認し、Terraformが扱う`docker_container`がビルド済みイメージから起動するだけの存在になっていることを確認した
* `name`属性の変更による強制再生成を実機で発生させ、**[第42回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part5/ansible-terraform-part5-42/)** で確認された設定消失が、ビルド時への転換によって実質的に解消されることを実機で確認した。これは、焼き込まれた設定が`docker_image`というコンテナとは別の独立したリソースに確定し、**[第47回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part5/ansible-terraform-part5-47/)** のVolumeと同様、コンテナの破棄、再生成の影響を受けなくなるためである
* 一方、**[第44回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part5/ansible-terraform-part5-44/)** ・**[第47回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part5/ansible-terraform-part5-47/)** で扱ったステートフルなデータの問題は、この転換によっても影響を受けない。データはビルド時点では未生成であり、Volume等の設計は引き続き必要である
* イミュータブル運用への移行は「Ansibleを使わない」ことではなく「Ansibleを使うタイミングを変える」ことであり、Playbookの実行対象が本番コンテナからビルド用の一時的な環境に変わっても、冪等性の確保等の設計上の配慮は引き続き必要である
* この転換は、`lifecycle`ブロックによる強制再生成という問題を回避できる代わりに、設定変更のたびにイメージの再ビルド、再デプロイが必要になるという新しい運用コストを生む。問題の消去ではなく、トレードオフとして捉える必要がある

---

[↑ 目次に戻る](#-目次)

---

## 8. 次回予告

第48回となる今回は、実行時にAnsibleで設定変更を加えるという運用そのものを見直し、ビルド時にAnsibleを組み込んでコンテナイメージへ設定を焼き込むイミュータブルな運用への転換を扱いました。`docker build`のビルドプロセス内でAnsibleを実行する方式を実機で構築し、ビルド済みイメージから起動したコンテナには一度もAnsibleを実行していないにもかかわらず設定が反映済みであること、`name`属性の変更による強制再生成後も **[第42回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part5/ansible-terraform-part5-42/)** のような設定消失が起きないことを、それぞれ実機で確認しました。一方で、この転換は稼働後に生成され続けるデータの問題には及ばず、また設定変更のたびにイメージの再ビルドが必要になるという新しい運用コストを伴うことも整理しました。

**[第41回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part5/ansible-terraform-part5-41/)** から今回まで、`create_before_destroy`や`replace_triggered_by`による強制再生成、`prevent_destroy`との衝突、リソース再生成に伴うデータの全喪失、依存リソースの変更による連鎖的再生成、プロビジョニング途中の接続切断、Volumeによるデータの分離、そしてビルド時への転換と、Terraformのライフサイクル操作がAnsibleの設定にどう影響するかを、さまざまな角度から実機で確認してきました。

次回は、これらの問題を未然に防ぐための仕組みに視点を移します。CI/CD環境において、誤ってDestroy & Createが走ってしまう事故を、`terraform plan`の差分ログを解析することで自動的にブロックするパイプラインガードの設計を扱います。

**[次回：第49回：CI/CD環境において再構築事故を物理的に防ぐパイプラインガード](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part5/ansible-terraform-part5-49/)**

---

📑 連載の移動　**[前の記事：【Ansible×Terraform編】第47回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part5/ansible-terraform-part5-47/)　｜　[次の記事：【Ansible×Terraform編】第49回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part5/ansible-terraform-part5-49/)**

---

> **🗺️ 初めての方、シリーズの全体像を知りたい方はこちら**
>
> シリーズ全体については、以下のまとめブログで整理しています。
>
> → **「AnsibleとTerraformの連携が壊れる理由はライフサイクルにあった」第5部まとめブログ：Terraformライフサイクル破壊編で明らかになった「認識の不可視性」の構造** **※近日公開予定**

---

[↑ 目次に戻る](#-目次)

---

## 9. 連載一覧：「AnsibleとTerraformの連携が壊れる理由はライフサイクルにあった」

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