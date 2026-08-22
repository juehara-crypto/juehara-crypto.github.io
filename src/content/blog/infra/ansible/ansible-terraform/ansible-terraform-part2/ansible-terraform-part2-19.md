---
title: '「AnsibleとTerraformの連携が壊れる理由はライフサイクルにあった」 第19回：OSのメジャーバージョンアップ時におけるPlaybookの互換性検証'
description: 'Terraform側でベースイメージ（例：Ubuntu 22.04→24.04）を変更した際、Ansibleの古い独自モジュールやシェルコマンドが機能しなくなる構造を整理する。Pythonバージョンの変化、コマンド・パッケージの非互換、モジュール自体の非互換を実機で確認し、本番切り替え前の段階的な検証フローを理解する。'
pubDate: 2026-08-24
category: 'infra'
tags: ['Ansible', 'Terraform', 'OSメジャーバージョンアップ', 'Playbook互換性', 'Ubuntu']
seriesId: 'ansible-terraform-part2'
seriesNo: 19
prevPost: 'https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part2/ansible-terraform-part2-18/'
nextPost: 'https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part2/ansible-terraform-part2-20/'
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
2. [Terraform側でのベースイメージ世代切り替え](#2-terraform側でのベースイメージ世代切り替え)
3. [Pythonバージョン変化による影響](#3-pythonバージョン変化による影響)
4. [廃止・変更されたコマンド・パッケージによる非互換](#4-廃止変更されたコマンドパッケージによる非互換)
5. [Ansibleモジュール自体の非互換](#5-ansibleモジュール自体の非互換)
6. [段階的な切り替えと検証フロー](#6-段階的な切り替えと検証フロー)
7. [まとめ](#7-まとめ)
8. [次回予告](#8-次回予告)
9. [連載一覧：「AnsibleとTerraformの連携が壊れる理由はライフサイクルにあった」](#9-連載一覧ansibleとterraformの連携が壊れる理由はライフサイクルにあった)
---

## 1. はじめに

「ベースイメージのバージョンを上げただけのつもりが、動いていたはずのPlaybookが軒並みエラーで止まった」という経験はないでしょうか。

**[第18回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part2/ansible-terraform-part2-18/)** では、機密情報という運用上のデータを、TerraformとAnsible Vaultのどちらに管理させるべきかを整理しました。今回扱うのは、データの管理場所ではなく、OSそのものの世代交代です。

**[第16回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part2/ansible-terraform-part2-16/)** では、`apt update`によってOS内部のパッケージバージョンが少しずつ進行し、Ansible Playbookの前提と食い違っていく問題を扱いました。あの回のバージョン変化は、誰も意図しないまま、運用の中で自然に発生するものでした。今回のOSメジャーバージョンアップは、これとは起点が異なります。ベースイメージを新しい世代に切り替えるかどうかは、Terraform側のコードを変更するという、明確に意図された操作から始まります。

具体的には、次のような場面です。

* Terraformのベースイメージ指定を、新しいOS世代（例：Ubuntu 22.04→24.04）に切り替えた
* `terraform apply`でリソースを再生成したところ、Ansible側の実行対象OSが一気に新世代へ変わった
* 以前は正常に完了していたPlaybookが、新世代のOS上ではエラーで止まるようになった

OSのメジャーバージョンアップでは、デフォルトのPythonバージョンが変わったり、パッケージマネージャーの挙動が変わったり、これまで使えていたコマンドのオプションが廃止されたりすることがあります。**[第16回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part2/ansible-terraform-part2-16/)** で扱ったのが「個々のパッケージの静かな前進」だったのに対し、今回はOS全体の前提が一度に変わるという点で、影響範囲が大きく異なります。

この回で扱う問いは、「OSのメジャーバージョンアップによる非互換をどう洗い出し、Playbookをどう検証してから本番のベースイメージを切り替えるか」です。

次のセクションでは、まずこの回全体の前提となる操作、Terraform側でのベースイメージ世代切り替えそのものを整理します。

---

[↑ 目次に戻る](#-目次)

---

## 2. Terraform側でのベースイメージ世代切り替え

この回の前提となる操作を整理します。

`.tf`ファイル内でベースイメージを新しいOS世代に切り替え、`terraform apply`で反映する操作を実機で確認します。

まず、新しいOS世代向けのDockerfileを用意します。

* **ファイル名：**`Dockerfile.ubuntu2404`
```dockerfile
FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y \
    openssh-server \
    python3 \
    sudo \
    iproute2 \
    curl \
    && rm -rf /var/lib/apt/lists/*

RUN mkdir /var/run/sshd

RUN useradd -m -s /bin/bash ansible && \
    echo 'ansible:ansible' | chpasswd && \
    echo 'ansible ALL=(ALL) NOPASSWD:ALL' >> /etc/sudoers

RUN mkdir -p /home/ansible/.ssh && \
    chown -R ansible:ansible /home/ansible/.ssh && \
    chmod 700 /home/ansible/.ssh

EXPOSE 22

CMD ["/usr/sbin/sshd", "-D"]
```

既存の`Dockerfile`（Ubuntu 22.04用）との違いは、ベースイメージのタグのみです。

続いて、`main.tf`に新しいイメージと、検証専用のコンテナを追加します。target-node1〜3本体には手を加えず、独立した検証用ノードとして扱います。

* **ファイル名：**`main.tf`（追記部分）
```hcl
resource "docker_image" "ansible_target_v2404" {
  name = "ansible-target:ubuntu24.04"
  build {
    context    = "."
    dockerfile = "Dockerfile.ubuntu2404"
  }
}

resource "docker_container" "target_v2404" {
  name  = "target-node-v2404"
  image = docker_image.ansible_target_v2404.image_id
  networks_advanced {
    name = docker_network.lab_net.name
  }
  ports {
    internal = 22
    external = 2224
  }
  upload {
    file    = "/home/ansible/.ssh/authorized_keys"
    content = "${file("${path.module}/id_ed25519.pub")}\n${tls_private_key.generated.public_key_openssh}"
  }
  upload {
    file    = "/etc/init_marker"
    content = "init_version=v1\n"
  }
}
```

### ■ 検証内容（新しいOS世代のイメージとコンテナが、実際にビルド、起動できることの確認）

**実行コマンド**
```plaintext
terraform apply
```

**▼ 実行結果**
```plaintext
（…target-node1〜3を含む既存リソースの再作成ログは省略…）

  # docker_image.ansible_target_v2404 will be created
  + resource "docker_image" "ansible_target_v2404" {
      + id          = (known after apply)
      + image_id    = (known after apply)
      + name        = "ansible-target:ubuntu24.04"
      + repo_digest = (known after apply)

      + build {
          + cache_from     = []
          + context        = "."
          + dockerfile     = "Dockerfile.ubuntu2404"
          + extra_hosts    = []
          + remove         = true
          + security_opt   = []
          + tag            = []
            # (11 unchanged attributes hidden)
        }
    }

（…中略…）

docker_image.ansible_target_v2404: Creating...
docker_image.ansible_target_v2404: Still creating... [00m10s elapsed]
docker_image.ansible_target_v2404: Still creating... [00m20s elapsed]
docker_image.ansible_target_v2404: Still creating... [00m30s elapsed]
docker_image.ansible_target_v2404: Still creating... [00m40s elapsed]
docker_image.ansible_target_v2404: Still creating... [00m50s elapsed]
docker_image.ansible_target_v2404: Still creating... [01m00s elapsed]
docker_image.ansible_target_v2404: Still creating... [01m10s elapsed]
docker_image.ansible_target_v2404: Still creating... [01m20s elapsed]
docker_image.ansible_target_v2404: Still creating... [01m30s elapsed]
docker_image.ansible_target_v2404: Still creating... [01m40s elapsed]
docker_image.ansible_target_v2404: Still creating... [01m50s elapsed]
docker_image.ansible_target_v2404: Still creating... [02m00s elapsed]
docker_image.ansible_target_v2404: Creation complete after 2m2s [id=sha256:fdc644bb57538bbe4a1ebd6e663a7266f82478face4db80d161fe019fca4c2efansible-target:ubuntu24.04]
docker_container.target_v2404: Creating...
docker_container.target_v2404: Creation complete after 2s [id=7b322282a4e294d4245a2af24fbb16a5bc1f56ed60106d7448f4378418e832c6]

Apply complete! Resources: 6 added, 0 changed, 1 destroyed.
```

`docker_image.ansible_target_v2404`のビルドには2分2秒かかっています。これは新しいベースイメージ（Ubuntu 24.04）を初めて取得し、パッケージをインストールする処理によるもので、既存の22.04系イメージのビルドより時間を要しています。ビルド完了後、`docker_container.target_v2404`（`target-node-v2404`）も正常に作成されました。

### ■ 結果

`.tf`ファイル内でベースイメージのタグを新しいOS世代に変更し、対応するDockerfileを用意することで、`terraform apply`から新世代のコンテナを起動できることが確認できました。この`target-node-v2404`が、以降のセクションで扱う検証対象になります。

ここで押さえておきたいのは、この操作がAnsibleにとって何を意味するかです。target-node1〜3が引き続きUbuntu 22.04で稼働している一方、`target-node-v2404`はUbuntu 24.04という、これまでとは異なるOS世代の上で動作しています。同じPlaybookをこの新しいノードに対して実行したとき、何が起きるかは、次のセクション以降で確認していきます。

---

[↑ 目次に戻る](#-目次)

---


## 3. Pythonバージョン変化による影響

OS世代変化が引き起こす代表的な非互換として、Pythonバージョンを取り上げます。

OS世代が上がると、デフォルトのPythonバージョンが変わることがあります。**[第7回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part1/ansible-terraform-part1-07/)** では、実行環境とターゲットOS間のPythonバージョン不一致がAnsibleの実行エラーを引き起こす問題を扱いました。今回は、この問題がベースイメージ世代切り替えのタイミングでどう現れるかを実機で確認します。

まず、Ansibleが検出するPythonインタープリタを、両方のOS世代で確認します。

* **ファイル名：**`playbooks/check_python_version.yml`
```yaml
---
- name: Pythonインタープリタのバージョンを確認する
  hosts: all
  gather_facts: true
  tasks:
    - name: 検出されたPythonインタープリタのパスとバージョンを表示する
      ansible.builtin.debug:
        msg: "interpreter={{ ansible_facts.python.executable }}, version={{ ansible_facts.python.version.major }}.{{ ansible_facts.python.version.minor }}.{{ ansible_facts.python.version.micro }}"
```

### ■ 検証内容（Ansibleの自動検出機能に任せた場合、OS世代ごとにどのPythonインタープリタが検出されるかの確認）

まず、旧世代のtarget-node1に対して実行します。

**実行コマンド**
```plaintext
ansible-playbook -i ~/iac/docker-lab/inventory.ini ~/iac/ansible/playbooks/check_python_version.yml --limit target-node1
```

**▼ 実行結果**
```plaintext
PLAY [Pythonインタープリタのバージョンを確認する] *******************************************************************************************************************************************
TASK [Gathering Facts] **********************************************************************************************************************************************************************
[WARNING]: Platform linux on host target-node1 is using the discovered Python interpreter at /usr/bin/python3.10, but future installation of another Python interpreter could change the
meaning of that path. See https://docs.ansible.com/ansible-core/2.17/reference_appendices/interpreter_discovery.html for more information.
ok: [target-node1]
TASK [検出されたPythonインタープリタのパスとバージョンを表示する] ***************************************************************************************************************************
ok: [target-node1] => {
    "msg": "interpreter=/usr/bin/python3.10, version=3.10.12"
}
PLAY RECAP **********************************************************************************************************************************************************************************
target-node1               : ok=2    changed=0    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
```

続けて、セクション2で作成した新世代のtarget-node-v2404に対して、同じPlaybookを実行します。

**実行コマンド**
```plaintext
ansible-playbook -i "172.20.0.5," -u ansible --private-key ~/iac/docker-lab/id_ed25519_generated ~/iac/ansible/playbooks/check_python_version.yml
```

**▼ 実行結果**
```plaintext
PLAY [Pythonインタープリタのバージョンを確認する] *******************************************************************************************************************************************
TASK [Gathering Facts] **********************************************************************************************************************************************************************
[WARNING]: Platform linux on host 172.20.0.5 is using the discovered Python interpreter at /usr/bin/python3.12, but future installation of another Python interpreter could change the
meaning of that path. See https://docs.ansible.com/ansible-core/2.17/reference_appendices/interpreter_discovery.html for more information.
ok: [172.20.0.5]
TASK [検出されたPythonインタープリタのパスとバージョンを表示する] ***************************************************************************************************************************
ok: [172.20.0.5] => {
    "msg": "interpreter=/usr/bin/python3.12, version=3.12.3"
}
PLAY RECAP **********************************************************************************************************************************************************************************
172.20.0.5                 : ok=2    changed=0    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
```

target-node1では`/usr/bin/python3.10`、target-node-v2404では`/usr/bin/python3.12`が、それぞれ自動検出されました。Ubuntu 22.04と24.04でデフォルトのPythonバージョンが異なるという構造が、Ansible側の検出結果にそのまま反映されています。

### ■ 結果

ここまでの結果を見る限り、OS世代が変わっても、Ansibleの自動検出機能に任せている限りエラーは発生しませんでした。しかし、これは「OS世代アップに対してPlaybookが常に安全」ということを意味しません。**[第7回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part1/ansible-terraform-part1-07/)** で扱った問題は、`ansible_python_interpreter`をパスとして明示的に固定するケースで発生していました。この固定が残ったままOS世代が切り替わった場合に何が起きるかを、続けて確認します。

**[第7回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part1/ansible-terraform-part1-07/)** の状況を模し、`ansible_python_interpreter`を旧世代のパスに固定したPlaybookを用意します。

* **ファイル名：**`playbooks/check_python_fixed_interpreter.yml`
```yaml
---
- name: 固定されたPythonインタープリタでの動作を確認する
  hosts: all
  vars:
    ansible_python_interpreter: /usr/bin/python3.10
  gather_facts: true
  tasks:
    - name: 検出されたPythonインタープリタのパスとバージョンを表示する
      ansible.builtin.debug:
        msg: "interpreter={{ ansible_facts.python.executable }}, version={{ ansible_facts.python.version.major }}.{{ ansible_facts.python.version.minor }}.{{ ansible_facts.python.version.micro }}"
```

### ■ 検証内容（旧世代のPythonパスに固定した場合、新世代のOSでどう振る舞うかの確認）

このPlaybookを、target-node-v2404に対して実行します。

**実行コマンド**
```plaintext
ansible-playbook -i "172.20.0.5," -u ansible --private-key ~/iac/docker-lab/id_ed25519_generated ~/iac/ansible/playbooks/check_python_fixed_interpreter.yml
```

**▼ 実行結果**
```plaintext
PLAY [固定されたPythonインタープリタでの動作を確認する] *************************************************************************************************************************************
TASK [Gathering Facts] **********************************************************************************************************************************************************************
fatal: [172.20.0.5]: FAILED! => {"ansible_facts": {}, "changed": false, "failed_modules": {"ansible.legacy.setup": {"failed": true, "module_stderr": "Shared connection to 172.20.0.5 closed.\r\n", "module_stdout": "/bin/sh: 1: /usr/bin/python3.10: not found\r\n", "msg": "The module failed to execute correctly, you probably need to set the interpreter.\nSee stdout/stderr for the exact error", "rc": 127}}, "msg": "The following modules failed to execute: ansible.legacy.setup\n"}
PLAY RECAP **********************************************************************************************************************************************************************************
172.20.0.5                 : ok=0    changed=0    unreachable=0    failed=1    skipped=0    rescued=0    ignored=0
```

`/usr/bin/python3.10: not found`というエラーで、ファクト収集の段階から失敗しました。target-node-v2404にはUbuntu 24.04のデフォルトである`python3.12`のみが存在し、`python3.10`というパス自体が存在しないためです。

### ■ 結果

同じOS世代の変化に対して、自動検出に任せたPlaybookはエラーなく動作し、パスを明示固定したPlaybookはエラーで停止しました。この違いは、`ansible_python_interpreter`をどう扱うかという設計判断そのものに起因します。

自動検出は、SSH接続後にターゲット側で利用可能なPythonインタープリタを探索する仕組みであるため、OS世代が変わってパスが変化しても、その時点で存在するインタープリタを見つけ出せます。一方、パスを明示的に固定する運用は、特定バージョンの動作を保証したい場合には有効ですが、そのパス自体がOS世代アップによって失われた場合、探索の余地なくエラーになります。

これは、**[第7回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part1/ansible-terraform-part1-07/)** で扱った「実行環境とターゲットOS間のPythonバージョン不一致」と根が同じ問題です。**[第7回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part1/ansible-terraform-part1-07/)** では実行環境側とターゲット側のズレが原因でしたが、今回はターゲット側がOS世代アップによって変化したことで、固定していたパスとの間に同種のズレが生じています。OS世代アップは、この種の「固定した前提」を静かに壊す典型的な引き金になり得るという点を、ここで押さえておきます。

---

[↑ 目次に戻る](#-目次)

---

## 4. 廃止・変更されたコマンド・パッケージによる非互換

コマンド・パッケージレベルでの非互換を整理します。

OS世代が上がると、パッケージ名の変更やコマンドオプションの廃止だけでなく、システムが標準で管理するファイルの配置や形式そのものが変わることもあります。ここでは、Ubuntu 24.04で実際に変更されたAPTのリポジトリ管理方式を、実機で確認します。

* **ファイル名：**`playbooks/check_apt_sources_format.yml`
```yaml
---
- name: APTソースファイルの形式を確認する
  hosts: all
  gather_facts: false
  tasks:
    - name: /etc/apt/sources.listの中身を表示する
      ansible.builtin.command: cat /etc/apt/sources.list
      register: sources_list_result
      changed_when: false

    - name: sources.listの内容を出力する
      ansible.builtin.debug:
        var: sources_list_result.stdout_lines

    - name: /etc/apt/sources.list.d配下のファイル一覧を確認する
      ansible.builtin.command: ls -la /etc/apt/sources.list.d/
      register: sources_list_d_result
      changed_when: false

    - name: sources.list.d配下の一覧を出力する
      ansible.builtin.debug:
        var: sources_list_d_result.stdout_lines
```

### ■ 検証内容（APTのリポジトリ定義ファイルの中身と配置が、OS世代によってどう変わるかの確認）

まず、旧世代のtarget-node1に対して実行します。

**実行コマンド**
```plaintext
ansible-playbook -i ~/iac/docker-lab/inventory.ini ~/iac/ansible/playbooks/check_apt_sources_format.yml --limit target-node1
```

**▼ 実行結果**
```plaintext
PLAY [APTソースファイルの形式を確認する] ****************************************************************************************************************************************************
TASK [/etc/apt/sources.listの中身を表示する] ************************************************************************************************************************************************
[WARNING]: Platform linux on host target-node1 is using the discovered Python interpreter at /usr/bin/python3.10, but future installation of another Python interpreter could change the
meaning of that path. See https://docs.ansible.com/ansible-core/2.17/reference_appendices/interpreter_discovery.html for more information.
ok: [target-node1]
TASK [sources.listの内容を出力する] *********************************************************************************************************************************************************
ok: [target-node1] => {
    "sources_list_result.stdout_lines": [
        "# See http://help.ubuntu.com/community/UpgradeNotes for how to upgrade to",
        "# newer versions of the distribution.",
        "deb http://archive.ubuntu.com/ubuntu/ jammy main restricted",
        "# deb-src http://archive.ubuntu.com/ubuntu/ jammy main restricted",
        "",
        "## Major bug fix updates produced after the final release of the",
        "## distribution.",
        "deb http://archive.ubuntu.com/ubuntu/ jammy-updates main restricted",
        "# deb-src http://archive.ubuntu.com/ubuntu/ jammy-updates main restricted",
        "",
        "## N.B. software from this repository is ENTIRELY UNSUPPORTED by the Ubuntu",
        "## team. Also, please note that software in universe WILL NOT receive any",
        "## review or updates from the Ubuntu security team.",
        "deb http://archive.ubuntu.com/ubuntu/ jammy universe",
        "# deb-src http://archive.ubuntu.com/ubuntu/ jammy universe",
        "deb http://archive.ubuntu.com/ubuntu/ jammy-updates universe",
        "# deb-src http://archive.ubuntu.com/ubuntu/ jammy-updates universe",
        "",
        "## N.B. software from this repository is ENTIRELY UNSUPPORTED by the Ubuntu",
        "## team, and may not be under a free licence. Please satisfy yourself as to",
        "## your rights to use the software. Also, please note that software in",
        "## multiverse WILL NOT receive any review or updates from the Ubuntu",
        "## security team.",
        "deb http://archive.ubuntu.com/ubuntu/ jammy multiverse",
        "# deb-src http://archive.ubuntu.com/ubuntu/ jammy multiverse",
        "deb http://archive.ubuntu.com/ubuntu/ jammy-updates multiverse",
        "# deb-src http://archive.ubuntu.com/ubuntu/ jammy-updates multiverse",
        "",
        "## N.B. software from this repository may not have been tested as",
        "## extensively as that contained in the main release, although it includes",
        "## newer versions of some applications which may provide useful features.",
        "## Also, please note that software in backports WILL NOT receive any review",
        "## or updates from the Ubuntu security team.",
        "deb http://archive.ubuntu.com/ubuntu/ jammy-backports main restricted universe multiverse",
        "# deb-src http://archive.ubuntu.com/ubuntu/ jammy-backports main restricted universe multiverse",
        "",
        "deb http://security.ubuntu.com/ubuntu/ jammy-security main restricted",
        "# deb-src http://security.ubuntu.com/ubuntu/ jammy-security main restricted",
        "deb http://security.ubuntu.com/ubuntu/ jammy-security universe",
        "# deb-src http://security.ubuntu.com/ubuntu/ jammy-security universe",
        "deb http://security.ubuntu.com/ubuntu/ jammy-security multiverse",
        "# deb-src http://security.ubuntu.com/ubuntu/ jammy-security multiverse"
    ]
}
TASK [/etc/apt/sources.list.d配下のファイル一覧を確認する] **********************************************************************************************************************************
ok: [target-node1]
TASK [sources.list.d配下の一覧を出力する] ***************************************************************************************************************************************************
ok: [target-node1] => {
    "sources_list_d_result.stdout_lines": [
        "total 8",
        "drwxr-xr-x 2 root root 4096 Apr  8  2022 .",
        "drwxr-xr-x 8 root root 4096 Jul 31 14:20 .."
    ]
}
PLAY RECAP **********************************************************************************************************************************************************************************
target-node1               : ok=4    changed=0    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
```

target-node1では、`/etc/apt/sources.list`にリポジトリ定義がすべて記載されており、`/etc/apt/sources.list.d/`は空でした。これは従来から馴染みのある形式です。

続けて、新世代のtarget-node-v2404に対して同じPlaybookを実行します。

**実行コマンド**
```plaintext
ansible-playbook -i "172.20.0.5," -u ansible --private-key ~/iac/docker-lab/id_ed25519_generated ~/iac/ansible/playbooks/check_apt_sources_format.yml
```

**▼ 実行結果**


```plaintext
PLAY [APTソースファイルの形式を確認する] ****************************************************************************************************************************************************
TASK [/etc/apt/sources.listの中身を表示する] ************************************************************************************************************************************************
[WARNING]: Platform linux on host 172.20.0.5 is using the discovered Python interpreter at /usr/bin/python3.12, but future installation of another Python interpreter could change the
meaning of that path. See https://docs.ansible.com/ansible-core/2.17/reference_appendices/interpreter_discovery.html for more information.
ok: [172.20.0.5]
TASK [sources.listの内容を出力する] *********************************************************************************************************************************************************
ok: [172.20.0.5] => {
    "sources_list_result.stdout_lines": [
        "# Ubuntu sources have moved to the /etc/apt/sources.list.d/ubuntu.sources",
        "# file, which uses the deb822 format. Use deb822-formatted .sources files",
        "# to manage package sources in the /etc/apt/sources.list.d/ directory.",
        "# See the sources.list(5) manual page for details."
    ]
}
TASK [/etc/apt/sources.list.d配下のファイル一覧を確認する] **********************************************************************************************************************************
ok: [172.20.0.5]
TASK [sources.list.d配下の一覧を出力する] ***************************************************************************************************************************************************
ok: [172.20.0.5] => {
    "sources_list_d_result.stdout_lines": [
        "total 12",
        "drwxr-xr-x 2 root root 4096 Aug 10 14:55 .",
        "drwxr-xr-x 8 root root 4096 Aug 10 14:48 ..",
        "-rw-r--r-- 1 root root 2552 Aug 10 14:55 ubuntu.sources"
    ]
}
PLAY RECAP **********************************************************************************************************************************************************************************
172.20.0.5                 : ok=4    changed=0    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
```

target-node-v2404では、`/etc/apt/sources.list`の中身は案内コメントのみで、実質的に空でした。リポジトリ定義の実体は、`/etc/apt/sources.list.d/ubuntu.sources`という新しいファイルに移動しています。

### ■ 結果

同じ`/etc/apt/sources.list`というパスでも、OS世代によって中身がまったく異なることが確認できました。22.04ではこのファイル自体にリポジトリ定義が記載されていましたが、24.04ではファイルはほぼ空で、実体は`sources.list.d/ubuntu.sources`という新しいDEB822形式のファイルに移動しています。

この変化は、`command`・`shell`タスクで`/etc/apt/sources.list`の中身を`grep`・`sed`等で直接参照、編集するPlaybookに影響します。特定のリポジトリ行を検索して書き換える、コメントアウトを解除する、といった処理を組んでいた場合、24.04環境ではファイルの中身が想定と異なるため、意図した変更が行われないまま処理だけが正常終了してしまう可能性があります。エラーにならずに済んでしまう分、この種の変化は気づきにくいという点は、第16回セクション4で確認した「設定ファイルの意味が静かに変わる変化」とも共通する構造です。

ここで扱ったAPTソースファイルの例は、OS世代間の非互換の一例に過ぎません。パッケージ名の変更や、特定のコマンドオプションの廃止・変更も、同種の構造で発生します。個々の非互換パターンを網羅的に洗い出すことがこの回の目的ではなく、「OS標準のファイル配置・形式そのものが、メジャーバージョンアップによって変わり得る」という前提を持つことが重要です。

---

[↑ 目次に戻る](#-目次)

---

## 5. Ansibleモジュール自体の非互換

モジュールレベルでの非互換を整理します。

セクション4では、`command`・`shell`タスクのように、Ansibleが生のコマンドやファイル操作をそのまま実行するケースで、OS世代の違いが表面化する様子を確認しました。ここで扱うのは、Ansibleが用意した抽象化されたモジュール自体が関わるケースです。

Ansibleの標準モジュール（`apt`、`user`、`service`等）は、多くの場合、OSディストリビューションやバージョンの違いをある程度吸収するよう設計されています。たとえば`apt`モジュールは、Ubuntu・Debian系であれば、内部的なAPTコマンドの細かな違いを意識せずに使えるよう抽象化されています。この抽象化があるからこそ、Playbookの記述自体はOSのバージョンに縛られず、同じタスクを異なる環境に対して使い回せます。

しかし、この抽象化には限界があります。モジュールが内部で呼び出している具体的なコマンドや、参照しているファイルパスが、OS世代によって変わることがあります。セクション4で確認した`/etc/apt/sources.list`の配置・形式の変化は、その典型的な例です。モジュール自体のインターフェース（Playbook側から見た使い方）が変わらなくても、内部で依存している前提が崩れれば、モジュールの抽象化だけでは吸収しきれない挙動の違いが生じる可能性があります。

この違いを整理すると、次のようになります。

```plaintext
コマンド・パッケージレベルの非互換（セクション4）：
Playbook側が直接指定した生のコマンド・パスが、OS世代によって通用しなくなる

モジュールレベルの非互換（このセクション）：
Playbook側の記述は変わらないが、モジュールが内部で依存する前提がOS世代によって崩れ、
モジュールの抽象化だけでは吸収しきれない挙動の違いが生じる
```

前者はPlaybookを見れば非互換の原因を特定しやすいのに対し、後者はPlaybookの記述自体に問題がないように見えるため、原因の特定が難しくなりやすいという性質があります。モジュールのバージョンアップやAnsible自体のアップデートによって、この種の非互換が徐々に解消されていくこともありますが、それを待つだけでなく、モジュールが対象OSでどう振る舞うかを事前に把握しておく姿勢が必要になります。

この観点は、個々のモジュールごとの非互換パターンを網羅することが目的ではありません。「Ansibleのモジュールは多くの部分を吸収してくれるが、万能ではない」という前提を持ったうえで、次のセクションで扱う段階的な検証フローの中で、モジュールレベルの非互換も含めて洗い出していく必要があるという点を、ここでは押さえておきます。

---

[↑ 目次に戻る](#-目次)

---

## 6. 段階的な切り替えと検証フロー

ここまでのセクションで確認した非互換パターンを踏まえ、本番環境への適用に進むまでの運用フローを整理します。

セクション3ではPythonインタープリタの固定パスが新世代で通用しなくなること、セクション4ではAPTソースファイルの配置・形式が変わること、セクション5ではAnsibleモジュールの抽象化だけでは吸収しきれない非互換が生じ得ることを、それぞれ確認してきました。これらはいずれも、ベースイメージを切り替えて実際にPlaybookを動かしてみて初めて発見できる種類の問題です。事前にすべてを予測することは現実的ではありません。

**[第16回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part2/ansible-terraform-part2-16/)** では、`apt update`によるパッケージバージョンの変化に対して、検証環境でイメージ更新とパッケージ更新の両方を確認したうえで本番へ適用する、というフローを整理しました。今回のOSメジャーバージョンアップも、この考え方の骨格自体は同じです。

```plaintext
検証環境のTerraformコードでベースイメージを新世代に変更する
　↓
terraform applyで検証環境のリソースを新世代へ切り替える
　↓
Playbook全体をansible-playbookで実行する
　↓
失敗したタスクを洗い出し修正する
　↓
全タスクが正常に完了することを確認する
　↓
本番環境のTerraformコード・Playbookに同様の変更を適用する
```

このフローは **[第16回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part2/ansible-terraform-part2-16/)** と同じ骨格ですが、対象範囲には大きな違いがあります。**[第16回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part2/ansible-terraform-part2-16/)** で扱った`apt update`は、個々のパッケージのバージョンという限定的な範囲の変化でした。一方、今回のベースイメージ世代切り替えは、Pythonインタープリタのパス、APTのファイル配置、そしてAnsibleモジュールが依存する内部的な前提まで、OS全体の土台が一度に変わる操作です。セクション2〜5で確認した非互換は、いずれもこの「土台が一度に変わる」という性質から生じたものでした。

この違いから、検証環境での確認作業も、対象がパッケージ単体だったときより広くなります。今回であれば、以下のような観点で失敗タスクを洗い出すことになります。

* `ansible_python_interpreter`をパスで固定しているタスクがないか（セクション3）
* `command`・`shell`タスクが、OS標準のファイル配置や形式を前提にしていないか（セクション4）
* 特定のAnsibleモジュールが、想定と異なる結果を返していないか（セクション5）

検証環境で洗い出した失敗タスクは、その場で修正し、再度Playbook全体を実行して正常完了することを確認します。この往復を経てから、本番環境のTerraformコードとAnsible Playbookに同様の変更を適用します。検証環境と本番環境で同じコードベースを使っていれば、この適用作業は、検証環境で行った変更をそのままリポジトリに反映するだけで済みます。

なお、このフローを経て一度洗い出しが完了しても、それで完全に安心できるわけではありません。今回のPlaybookで使っていないモジュールや、実行していないコマンドの中に、まだ見つかっていない非互換が潜んでいる可能性は残ります。継続的にこの種の非互換を検知し続ける仕組み（CI/CDパイプラインへの組み込み等）は、第4部（改善・CI/CD自動化編）、および第34回で扱うTestinfraによる状態検証の領域と接続します。この回では、あくまで本番切り替え前の一度きりの検証フローとして扱う範囲にとどめます。

---

[↑ 目次に戻る](#-目次)

---

## 7. まとめ

この回で整理した内容を確認します。

* Terraform側でベースイメージを新しいOS世代に切り替える操作は、`terraform apply`によるリソースの再生成を伴い、Ansibleの実行対象OSを一気に変える。実機検証では、Ubuntu 22.04と24.04それぞれのコンテナを用意し、以降のセクションで両者の挙動を比較した
* OS世代が上がるとデフォルトのPythonインタープリタが変わる。実機検証では、Ubuntu 22.04で`/usr/bin/python3.10`、Ubuntu 24.04で`/usr/bin/python3.12`が自動検出される様子を確認した。Ansibleの自動検出に任せている場合はエラーにならない一方、`ansible_python_interpreter`を旧世代のパスに固定していると、新世代では`not found`となり実行自体が失敗することを確認した
* OS標準のファイル配置や形式も、メジャーバージョンアップによって変わることがある。実機検証では、APTのリポジトリ定義が、Ubuntu 22.04では`/etc/apt/sources.list`に直接記載されていたのに対し、Ubuntu 24.04では同ファイルがほぼ空になり、実体が`/etc/apt/sources.list.d/ubuntu.sources`という新しいDEB822形式のファイルに移動している様子を確認した
* Ansibleモジュール自体も、OS世代の違いをある程度吸収するよう設計されているが、万能ではない。モジュールが内部で依存するコマンドやファイルパスの前提が崩れた場合、モジュールの抽象化だけでは吸収しきれない非互換が残ることがある
* 検証環境でベースイメージを先行して切り替え、Playbook全体を実行して失敗するタスクを洗い出したうえで、本番環境に同様の変更を適用するという運用フローが、本番切り替え前の必須プロセスになる。パッケージ単体の更新を扱った **[第16回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part2/ansible-terraform-part2-16/)** よりも、確認すべき範囲が広くなる点が今回の特徴である

---

[↑ 目次に戻る](#-目次)

---

## 8. 次回予告

**[第18回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part2/ansible-terraform-part2-18/)** では、機密情報という運用上のデータを、TerraformとAnsible Vaultのどちらに管理させるべきかを整理しました。

今回はその視点を、データの管理場所からOSそのものの世代交代へ移しました。Terraform側でベースイメージを新しいOS世代に切り替える操作が、Ansibleの実行対象OSを一気に変えるという構造を確認したうえで、Pythonインタープリタの自動検出とパス固定の違い、APTのリポジトリ定義ファイルの配置・形式の変化を実機で確認しました。あわせて、Ansibleモジュール自体が持つ抽象化の限界と、検証環境を経由した段階的な切り替えフローを整理しました。

次回は、第2部全体のまとめとして、ミュータブル運用とイミュータブル運用の折衷案を扱います。**[第11回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part2/ansible-terraform-part2-11/)** から今回までで扱ってきた個別の事象を踏まえ、状態を維持し続ける運用と、使い捨てる運用を、TerraformとAnsibleの組み合わせでどう着地させるかを整理します。

**[次回：第20回：運用編まとめ：ミュータブル運用とイミュータブル運用の折衷案](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part2/ansible-terraform-part2-20/)**

---

📑 連載の移動　**[前の記事：【Ansible×Terraform編】第18回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part2/ansible-terraform-part2-18/)　｜　[次の記事：【Ansible×Terraform編】第20回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part2/ansible-terraform-part2-20/)**

---

> **🗺️ 初めての方・シリーズの全体像を知りたい方はこちら**
> 
> シリーズ全体については、以下のまとめブログで整理しています。
> 
> → **「AnsibleとTerraformの連携が壊れる理由はライフサイクルにあった」第2部まとめブログ： TerraformとAnsibleの運用で直面する構成ズレと状態管理の問題** **※近日公開予定**

---

[↑ 目次に戻る](#-目次)

---

## 9. 連載一覧：「AnsibleとTerraformの連携が壊れる理由はライフサイクルにあった」

### 第2部：運用・ライフサイクル編

|回数|テーマ・記事タイトル|概要|
|---|---|---|
|**[第11回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part2/ansible-terraform-part2-11/)**|手動変更による構成ドリフトの検知と同期手法|構築後に手動やAnsibleで変更したOS内部の状態を、Terraformの`plan`が検知できず、インフラの管理状態に不整合が出る問題。ドリフトシリーズとの接続を示す。|
|**[第12回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part2/ansible-terraform-part2-12/)**|`terraform apply`実行時における初期化処理とOS設定の上書き問題|Terraform側で初期化スクリプトやコンテナ起動定義を書き換えて再実行した際、Ansibleによって設定済みのOS内部状態が初期化される課題。|
|**[第13回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part2/ansible-terraform-part2-13/)**|コード修正に伴うリソースの強制再生成（リビルド）リスク|TerraformのHCL定義変更によって、リソースが「更新」ではなく「破棄、再生成」され、Ansibleが投入した内部データが消失する課題。|
|**[第14回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part2/ansible-terraform-part2-14/)**|複数回実行時におけるAnsible Playbookの冪等性の確保|`terraform apply`のlocal-exec経由でAnsibleが複数回実行される構成において、冪等性が確保されていないPlaybookがterraform apply自体の失敗を引き起こす問題。|
|**[第15回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part2/ansible-terraform-part2-15/)**|チーム運用における状態管理ファイル（tfstate）の整合性維持|Ansibleを実行するオペレーターと、Terraformを管理するエンジニア間で、Terraformの状態管理ファイルに競合が発生するリスク。チーム運用での役割分担設計も整理する。|
|**[第16回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part2/ansible-terraform-part2-16/)**|パッケージアップデートに伴う環境の非互換性への対応|運用中に`apt update`等を実行した結果、OSのライブラリやミドルウェアのバージョンが上がり、Terraformの定義と矛盾が生じるケース。|
|**[第17回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part2/ansible-terraform-part2-17/)**|リソース再生成時におけるIPアドレス変動と接続情報の更新遅延|リソース（コンテナ/VM）の再生成に伴ってIPアドレスが変更された際、Ansible用のインベントリや各種設定ファイルの書き換えが追いつかない問題。|
|**[第18回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part2/ansible-terraform-part2-18/)**|TerraformとAnsible Vaultにおける機密情報の役割分担|データベースのパスワードやAPIキーなどの機密情報を、両ツールのどちらで暗号化し、どのように管理すべきかの運用設計。Vault誤用パターンと回避策も整理する。|
|**[第19回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part2/ansible-terraform-part2-19/)**|OSのメジャーバージョンアップ時におけるPlaybookの互換性検証|Terraform側でベースイメージ（例：Ubuntu 22.04→24.04）を変更した際、Ansibleの古い独自モジュールやシェルコマンドが機能しなくなる課題。|
|**[第20回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part2/ansible-terraform-part2-20/)**|運用編まとめ：ミュータブル運用とイミュータブル運用の折衷案|状態（データ）を維持し続ける運用（ミュータブル）と、使い捨てる運用（イミュータブル）を、両ツールの組み合わせでどのように着地させるかの最適解。|

---

[↑ 目次に戻る](#-目次)

---

