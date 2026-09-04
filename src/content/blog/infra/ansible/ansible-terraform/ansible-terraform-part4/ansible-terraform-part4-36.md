---
title: '「AnsibleとTerraformの連携が壊れる理由はライフサイクルにあった」 第36回：プラグインおよびパッケージのキャッシュによる開発効率の向上'
description: 'Terraformのプラグインキャッシュ機能とAnsible実行時のaptパッケージキャッシュを扱い、検証を繰り返す開発サイクルにおける待ち時間の削減を整理する。'
pubDate: 2026-09-04
category: 'infra'
tags: ['Ansible', 'Terraform', 'キャッシュ', 'apt-cacher-ng', 'CI/CD']
seriesId: 'ansible-terraform-part4'
seriesNo: 36
prevPost: 'https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part4/ansible-terraform-part4-35/'
nextPost: 'https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part4/ansible-terraform-part4-37/'
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
2. [Terraformプラグインキャッシュの仕組みと設定](#2-terraformプラグインキャッシュの仕組みと設定)
3. [Ansible実行時のaptパッケージキャッシュの構築](#3-ansible実行時のaptパッケージキャッシュの構築)
4. [キャッシュ導入前後のAnsible実行時間の比較](#4-キャッシュ導入前後のansible実行時間の比較)
5. [キャッシュの限界と注意点](#5-キャッシュの限界と注意点)
6. [まとめ](#6-まとめ)
7. [次回予告](#7-次回予告)
8. [連載一覧：「AnsibleとTerraformの連携が壊れる理由はライフサイクルにあった」](#8-連載一覧ansibleとterraformの連携が壊れる理由はライフサイクルにあった)

---

## 1. はじめに

`terraform init`を実行するたびに、毎回同じproviderをネットワーク経由で取得し直していることに気づいたことはないでしょうか。

**[第31回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part4/ansible-terraform-part4-31/)** から **[第35回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part4/ansible-terraform-part4-35/)** では、TerraformとAnsibleの実行順序、検証、コード構造をどう設計するかを扱ってきました。第36回となる今回は視点を変え、これまでの検証作業そのものにかかっていた待ち時間に着目します。

検証のたびに、`terraform init`でのprovider再ダウンロードや、Ansible Playbookでのパッケージインストールが繰り返されてきました。この回では、Terraformのプラグインキャッシュ機能と、aptパッケージのキャッシュを設定し、検証サイクルにおける待ち時間の削減を扱います。

問いは、「検証を繰り返す開発サイクルにおいて、どこにキャッシュを効かせれば効果が大きいのか」です。

次のセクションでは、Terraform側のキャッシュ設定を確認します。

---

[↑ 目次に戻る](#-目次)

---

## 2. Terraformプラグインキャッシュの仕組みと設定

Terraform側のキャッシュ設定方法を確認します。

`terraform init`を実行するたびに、`.terraform/providers`配下にproviderが再取得される構造になっています。この回では、`~/.terraformrc`に`plugin_cache_dir`を設定することで、この構造を変更します。

* **ファイル名：`~/.terraformrc`（新規作成）**

```hcl
plugin_cache_dir = "$HOME/.terraform.d/plugin-cache"
```

キャッシュ先のディレクトリを作成したうえで、この設定ファイルを配置します。

```plaintext
mkdir -p ~/.terraform.d/plugin-cache
```

### ■ 検証内容：`plugin_cache_dir`設定後における`terraform init`の確認

`docker-lab`とは別に、`kreuzwerker/docker`providerのみを参照する検証用の新規ディレクトリ（`~/iac/docker-lab-cache-test`）を用意し、`terraform init`を実行します。

* **ファイル名：`main.tf`**

```hcl
terraform {
  required_providers {
    docker = {
      source  = "kreuzwerker/docker"
      version = "~> 3.0.0"
    }
  }
}
```

**実行コマンド**

```plaintext
terraform init
```

**▼ 実行結果**

```plaintext
Initializing provider plugins found in the configuration...
- Finding kreuzwerker/docker versions matching "~> 3.0.0"...
- Installing kreuzwerker/docker v3.0.2...
- Installed kreuzwerker/docker v3.0.2 (self-signed, key ID BD080C4571C6104C)
Partner and community providers are signed by their developers.
If you'd like to know more about provider signing, you can read about it here:
https://developer.hashicorp.com/terraform/cli/plugins/signing
Initializing the backend...
Terraform has created a lock file .terraform.lock.hcl to record the provider
selections it made above. Include this file in your version control repository
so that Terraform can guarantee to make the same selections by default when
you run "terraform init" in the future.
Terraform has been successfully initialized!
You may now begin working with Terraform. Try running "terraform plan" to see
any changes that are required for your infrastructure. All Terraform commands
should now work.
If you ever set or change modules or backend configuration for Terraform,
rerun this command to reinitialize your working directory. If you forget, other
commands will detect it and remind you to do so if necessary.
```

`Installing kreuzwerker/docker v3.0.2...`という表示だけでは、ネットワークから新規に取得したのか、キャッシュから参照したのかを判別できません。`.terraform/providers`配下の実体を確認します。

**実行コマンド**

```plaintext
ls -la .terraform/providers/registry.terraform.io/kreuzwerker/docker/3.0.2/
```

**▼ 実行結果**

```plaintext
total 12
drwxr-xr-x 2 control control 4096 Sep  4 03:01 .
drwxr-xr-x 3 control control 4096 Sep  4 03:01 ..
lrwxrwxrwx 1 control control   98 Sep  4 03:01 linux_amd64 -> /home/control/.terraform.d/plugin-cache/registry.terraform.io/kreuzwerker/docker/3.0.2/linux_amd64
```

### ■ 結果

`linux_amd64`がシンボリックリンクとなっており、リンク先は`~/.terraform.d/plugin-cache/registry.terraform.io/kreuzwerker/docker/3.0.2/linux_amd64`でした。プロジェクト側の`.terraform/providers`には実体が置かれておらず、キャッシュディレクトリ側の本体を参照する構成になっています。

キャッシュディレクトリ側の実体も確認します。

**実行コマンド**

```plaintext
ls -la ~/.terraform.d/plugin-cache/registry.terraform.io/kreuzwerker/docker/3.0.2/linux_amd64/
```

**▼ 実行結果**

```plaintext
total 17996
drwxr-xr-x 2 control control     4096 Sep  4 03:01 .
drwxr-xr-x 3 control control     4096 Sep  4 03:01 ..
-rw-r--r-- 1 control control    26007 Sep  4 03:01 CHANGELOG.md
-rw-r--r-- 1 control control    16725 Sep  4 03:01 LICENSE
-rw-r--r-- 1 control control     4387 Sep  4 03:01 README.md
-rwxr-xr-x 1 control control 18362368 Sep  4 03:01 terraform-provider-docker_v3.0.2
```

`terraform-provider-docker_v3.0.2`という実体ファイルがキャッシュディレクトリ側に存在し、プロジェクト側からはこの実体へのシンボリックリンクを通じて参照される構造になっていることが確認できました。`plugin_cache_dir`の設定によって、`terraform init`のたびにネットワークから再取得するのではなく、ローカルキャッシュから参照する構成に切り替わっています。

なお、この検証環境で使用するproviderは`kreuzwerker/docker`という小〜中規模のcommunity providerであり、AWS providerのような数百MB級のものと比べるとサイズが小さいため、`terraform init`の所要時間そのものはキャッシュの有無に関わらず数秒〜十数秒程度にとどまり、体感できるほどの差は生じにくい点は、5節で改めて整理します。

---

[↑ 目次に戻る](#-目次)

---

## 3. Ansible実行時のaptパッケージキャッシュの構築

Ansible側のキャッシュ設定方法を確認します。

target-node1〜3は、それぞれが個別にインターネット経由でaptパッケージを取得する構成になっています。

```
【キャッシュなしの構成】
target-node1 → インターネット上のaptリポジトリへ直接アクセス
target-node2 → インターネット上のaptリポジトリへ直接アクセス
target-node3 → インターネット上のaptリポジトリへ直接アクセス
　　　　　（同じパッケージを3台がそれぞれ個別にダウンロード）
```

Ubuntu-Controlに`apt-cacher-ng`を導入し、target-node1〜3がそこを参照する構成に変更します。

**実行コマンド**

```plaintext
sudo apt update
sudo apt install -y apt-cacher-ng
```

インストール後、サービスの稼働状況とポートを確認します。

**実行コマンド**

```plaintext
sudo systemctl status apt-cacher-ng
sudo ss -tlnp | grep apt-cacher
```

**▼ 実行結果**

```plaintext
● apt-cacher-ng.service - Apt-Cacher NG software download proxy
     Loaded: loaded (/lib/systemd/system/apt-cacher-ng.service; enabled; vendor preset: enabled)
     Active: active (running) since Fri 2026-09-04 04:09:31 UTC; 41s ago
   Main PID: 4045 (apt-cacher-ng)
      Tasks: 1 (limit: 2215)
     Memory: 2.3M
        CPU: 27ms
     CGroup: /system.slice/apt-cacher-ng.service
             └─4045 /usr/sbin/apt-cacher-ng -c /etc/apt-cacher-ng ForeGround=1
Sep 04 04:09:31 ubuntu-controller systemd[1]: Starting Apt-Cacher NG software download proxy...
Sep 04 04:09:31 ubuntu-controller systemd[1]: Started Apt-Cacher NG software download proxy.
LISTEN 0      250          0.0.0.0:3142      0.0.0.0:*    users:(("apt-cacher-ng",pid=4045,fd=11))
LISTEN 0      250             [::]:3142         [::]:*    users:(("apt-cacher-ng",pid=4045,fd=12))
```

`apt-cacher-ng`は、デフォルトでポート3142で待ち受けます。

target-node1〜3側から、このapt-cacher-ngを参照するようプロキシ設定を配布するため、新規のAnsible Role（`common_setup`）を作成します。

* **ファイル名：`roles/common_setup/tasks/main.yml`（新規作成）**

```yaml
---
- name: apt_cache.ymlを読み込み
  ansible.builtin.import_tasks: apt_cache.yml
```

* **ファイル名：`roles/common_setup/tasks/apt_cache.yml`（新規作成）**

```yaml
---
- name: apt-cacher-ng経由でaptパッケージを取得するようプロキシを設定
  become: true
  ansible.builtin.copy:
    dest: /etc/apt/apt.conf.d/02proxy
    content: 'Acquire::http::Proxy "http://172.20.0.1:3142";'
```

target-node1〜3はDockerブリッジネットワーク経由でUbuntu-Controlに到達するため、プロキシ先のアドレスにはDockerブリッジネットワークのゲートウェイアドレスを指定します。

`site.yml`の`roles`に、この新規Roleを追加します。

* **ファイル名：`site.yml`（該当箇所）**

**【変更前】**

```yaml
  roles:
    - common
```

**【変更後】**

```yaml
  roles:
    - common
    - common_setup
```

### ■ 検証内容：common_setup追加後におけるプロキシ設定配布の確認

**実行コマンド**


```plaintext
ansible-playbook -i inventory.ini site.yml
```

**▼ 実行結果**

```plaintext
PLAY [接続確認用Playbook] *******************************************************************************************************************************************************************
TASK [common : 疎通確認（common role・第35回更新）] *****************************************************************************************************************************************
[WARNING]: Platform linux on host target-node2 is using the discovered Python interpreter at /usr/bin/python3.10, but future installation of another Python interpreter could change the
meaning of that path. See https://docs.ansible.com/ansible-core/2.17/reference_appendices/interpreter_discovery.html for more information.
ok: [target-node2]
[WARNING]: Platform linux on host target-node1 is using the discovered Python interpreter at /usr/bin/python3.10, but future installation of another Python interpreter could change the
meaning of that path. See https://docs.ansible.com/ansible-core/2.17/reference_appendices/interpreter_discovery.html for more information.
ok: [target-node1]
[WARNING]: Platform linux on host target-node3 is using the discovered Python interpreter at /usr/bin/python3.10, but future installation of another Python interpreter could change the
meaning of that path. See https://docs.ansible.com/ansible-core/2.17/reference_appendices/interpreter_discovery.html for more information.
ok: [target-node3]
TASK [common_setup : apt-cacher-ng経由でaptパッケージを取得するようプロキシを設定] **********************************************************************************************************
changed: [target-node3]
changed: [target-node2]
changed: [target-node1]
PLAY RECAP **********************************************************************************************************************************************************************************
target-node1               : ok=2    changed=1    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
target-node2               : ok=2    changed=1    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
target-node3               : ok=2    changed=1    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
```

### ■ 結果

target-node1〜3すべてで`changed`となり、`/etc/apt/apt.conf.d/02proxy`が正常に配布されました。target-node1で実際のファイル内容を確認します。

**実行コマンド**

```plaintext
ssh -p 22 -i ~/.ssh/id_ed25519 ansible@172.18.0.2 "cat /etc/apt/apt.conf.d/02proxy"
```

**▼ 実行結果**

```plaintext
Acquire::http::Proxy "http://172.20.0.1:3142";
```

意図した内容がそのまま反映されていることが確認できました。

```
【キャッシュありの構成】
target-node1 ─┐
target-node2 ─┼→ Ubuntu-Control（apt-cacher-ng） → インターネット上のaptリポジトリ
target-node3 ─┘
　　　　　（初回のみインターネットから取得、以降はキャッシュから配布）
```

---

[↑ 目次に戻る](#-目次)

---

## 4. キャッシュ導入前後のAnsible実行時間の比較

apt-cacher-ngの効果を実測で確認します。

target-node1〜3に対して、同一のパッケージインストールタスク（`nginx`）を順に実行し、所要時間を比較します。

* **ファイル名：`test_apt_cache.yml`（新規作成）**

```yaml
---
- name: apt-cacher-ng効果測定用Playbook
  hosts: target-node1
  gather_facts: false
  become: true

  tasks:
    - name: nginxをインストール
      ansible.builtin.apt:
        name: nginx
        update_cache: true
```

### ■ 検証内容：target-node1〜3への順次インストールによる所要時間比較

`hosts`をtarget-node1、target-node2、target-node3の順に切り替えながら、`time`コマンドで実行時間を計測します。

**実行コマンド**

```plaintext
time ansible-playbook -i inventory.ini test_apt_cache.yml
```

**▼ 実行結果（target-node1）**

```plaintext
PLAY [apt-cacher-ng効果測定用Playbook] ******************************************************************************************************************************************************
TASK [nginxをインストール] ******************************************************************************************************************************************************************
changed: [target-node1]
PLAY RECAP **********************************************************************************************************************************************************************************
target-node1               : ok=1    changed=1    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
real    1m26.360s
user    0m7.153s
sys     0m2.386s
```

**▼ 実行結果（target-node2）**

```plaintext
PLAY [apt-cacher-ng効果測定用Playbook] ******************************************************************************************************************************************************
TASK [nginxをインストール] ******************************************************************************************************************************************************************
changed: [target-node2]
PLAY RECAP **********************************************************************************************************************************************************************************
target-node2               : ok=1    changed=1    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
real    0m39.949s
user    0m3.325s
sys     0m0.796s
```

**▼ 実行結果（target-node3）**

```plaintext
PLAY [apt-cacher-ng効果測定用Playbook] ******************************************************************************************************************************************************
TASK [nginxをインストール] ******************************************************************************************************************************************************************
changed: [target-node3]
PLAY RECAP **********************************************************************************************************************************************************************************
target-node3               : ok=1    changed=1    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
real    0m36.581s
user    0m3.479s
sys     0m0.997s
```

### ■ 結果

|ノード|所要時間|
|---|---|
|target-node1（1台目）|1分26秒|
|target-node2（2台目）|39秒|
|target-node3（3台目）|37秒|

target-node1は、apt-cacher-ng側にまだ`nginx`関連パッケージのキャッシュが存在しないため、インターネットから直接取得する形になり、1分26秒を要しました。target-node2は、target-node1のインストール時にapt-cacher-ng側へキャッシュされたパッケージを再利用したことで、39秒まで短縮されました。target-node3も同様にキャッシュを再利用し、37秒でした。

1台目と2台目以降の間に明確な差が生じており、初回のみキャッシュが存在せず時間短縮の効果が出ない、という非対称性が実機で確認できました。

---

[↑ 目次に戻る](#-目次)

---

## 5. キャッシュの限界と注意点

この回のトレードオフを整理します。

### ■ Terraform側のキャッシュ効果の実測

`kreuzwerker/docker`providerを対象に、キャッシュあり・キャッシュなしの状態それぞれで`terraform init`の所要時間を計測しました。

**実行コマンド**

```plaintext
time terraform init
```

**▼ 実行結果（キャッシュあり、1回目）**

```plaintext
real    0m4.600s
user    0m0.383s
sys     0m1.129s
```

**▼ 実行結果（キャッシュなし、1回目）**

```plaintext
real    0m2.689s
user    0m0.467s
sys     0m0.911s
```

**▼ 実行結果（キャッシュあり、2回目）**

```plaintext
real    0m3.517s
user    0m0.399s
sys     0m0.681s
```

**▼ 実行結果（キャッシュなし、2回目）**

```plaintext
real    0m2.423s
user    0m0.297s
sys     0m0.839s
```

### ■ 結果

|試行|キャッシュあり|キャッシュなし|
|---|---|---|
|1回目|4.600秒|2.689秒|
|2回目|3.517秒|2.423秒|

2回の計測とも、キャッシュなしの方が速いという結果になりました。`kreuzwerker/docker`は約18MBの小規模なcommunity providerであり、この検証環境（ローカルネットワーク内で完結する取得経路）では、ネットワーク転送そのものがボトルネックになっておらず、`plugin_cache_dir`によるシンボリックリンクの作成・照合処理が、素のダウンロードよりもむしろ数秒のオーバーヘッドとして働く結果になりました。

この結果は、「`plugin_cache_dir`の設定自体は有効に機能しているが、providerのサイズや取得元との回線条件次第では、キャッシュを使わない方が速い場合がある」ことを示しています。効果の有無を分けるのは、providerの種類とサイズ、そして取得元までの回線条件です。AWS providerのように1つで300〜400MB程度あるproviderを、実際の外部レジストリからダウンロードする環境であれば、この結果とは逆に、キャッシュによる数十秒単位の短縮効果が見込めます。

### ■ Ansible側のキャッシュに関する注意点

セクション3・4で構築したapt-cacher-ngについても、以下の限界があります。

|項目|内容|
|---|---|
|バージョンの乖離|apt-cacher-ngにキャッシュされたパッケージバージョンと、最新のリポジトリ上のバージョンとの間にズレが生じうる|
|運用対象の増加|apt-cacher-ng自体のディスク容量管理・キャッシュの更新タイミングという、新たな管理対象が増える|

Terraform側のキャッシュについては、「設定はできるが、この検証環境の規模・回線条件では効果を実感しにくい、むしろ遅くなる場合がある」という結果を実測のまま示した上で、効果の有無を左右するのはproviderの種類・サイズ・回線条件であることを整理しました。

---

[↑ 目次に戻る](#-目次)

---

## 6. まとめ

この回で整理した内容を確認します。

* `terraform init`のたびにproviderがネットワーク経由で再取得される構造があり、`~/.terraformrc`に`plugin_cache_dir`を設定することで、ローカルキャッシュから参照する構成に変更できることを実機で確認した
* `kreuzwerker/docker`のようにサイズが小さいproviderの場合、この検証環境（ローカルネットワーク内で完結する取得経路）では、キャッシュありの方がキャッシュなしより遅い結果になることを実機の計測で確認した。効果の有無を左右するのはproviderの種類・サイズ・回線条件である
* target-node1〜3が個別にaptパッケージを取得していた構成に対し、Ubuntu-Controlに`apt-cacher-ng`を構築し、target-node1〜3がそれを参照する構成に変更することで、2台目以降のパッケージインストールが明確に高速化することを実機で確認した（1台目：1分26秒、2台目：39秒、3台目：37秒）
* apt-cacher-ngによるキャッシュ効果には非対称性があり、キャッシュがまだ存在しない初回のノードでは短縮効果が出ない
* キャッシュ導入によって検証サイクルの待ち時間が短縮される一方、パッケージバージョンの乖離やキャッシュサーバー自体の運用という新たな関心事が生じる

---

[↑ 目次に戻る](#-目次)

---

## 7. 次回予告

**[第31回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part4/ansible-terraform-part4-31/)** から **[第35回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part4/ansible-terraform-part4-35/)** では、TerraformとAnsibleの実行順序、検証、コード構造をどう設計するかを扱ってきました。第36回となる今回は、視点を変え、検証作業そのものにかかっていた待ち時間に着目しました。Terraformのプラグインキャッシュとapt-cacher-ngによるAPTパッケージキャッシュを設定し、Terraform側は検証環境の規模ではむしろ効果が出にくい場合があること、Ansible側は明確な高速化が見込めることを、実機検証を交えて確認しました。

次回は、スケジュール実行によって構成ドリフトを自動検知し、差分があった場合のみAnsibleを自動収束させるパイプライン設計を扱います。

**[次回：第37回：定期実行による構成ドリフトの自動検知と収束パイプライン](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part4/ansible-terraform-part4-37/)**

---

📑 連載の移動　**[前の記事：【Ansible×Terraform編】第35回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part4/ansible-terraform-part4-35/)　｜　[次の記事：【Ansible×Terraform編】第37回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part4/ansible-terraform-part4-37/)**

---

> **🗺️ 初めての方、シリーズの全体像を知りたい方はこちら**
> 
> シリーズ全体については、以下のまとめブログで整理しています。
> 
> → **「AnsibleとTerraformの連携が壊れる理由はライフサイクルにあった」シリーズ統合ブログ** **※近日公開予定**

---

[↑ 目次に戻る](#-目次)

---

## 8. 連載一覧：「AnsibleとTerraformの連携が壊れる理由はライフサイクルにあった」

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
|**[第40回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part4/ansible-terraform-part4-40/)**|改善、CI/CD編まとめ：プロビジョニング自動化の成熟度モデル|手動実行から状態連携、CI/CD化、自動収束（Level 1〜4）に至るまでのインフラ自動化の成熟度の整理。|

---

[↑ 目次に戻る](#-目次)

---
