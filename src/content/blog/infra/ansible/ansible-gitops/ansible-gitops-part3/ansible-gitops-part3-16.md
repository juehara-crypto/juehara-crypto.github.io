---
title: '「Ansible×TerraformをGitOpsで回す」〜Terraformプロバイダーを問わない構成管理の自動化〜 第16回：Vault情報が漏洩・破損した場合の復旧設計'
description: 'これまでの回で決めた機密情報の置き場所が、漏れたとき、失われたときの復旧を扱う。漏洩と破損を分け、GitHub Secretsが読み出せないこと、Vaultパスワードを変えても過去のコミットの暗号文は守れないことを実機で確かめる。秘密の値そのものの入れ替えをプルリクエストと承認ゲートに通し、Vault IDで新旧のパスワードを併用して段階的に切り替える。入れ替えのコミットをrevertしてはいけない理由を、ロールバックの非対称性と接続して整理する。第3部の最終回。'
pubDate: 2026-10-20
category: 'infra'
tags: ['Ansible', 'Terraform', 'GitOps', 'Ansible Vault', '機密情報管理']
seriesId: 'ansible-gitops-part3'
seriesNo: 16
prevPost: 'https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part3/ansible-gitops-part3-15/'
nextPost: 'https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part4/ansible-gitops-part4-17/'
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
2. [漏洩と破損を分ける](#2-漏洩と破損を分ける)
3. [GitHub Secretsは読み出せない](#3-github-secretsは読み出せない)
4. [Vaultパスワードを変えても過去の暗号文は守れない](#4-vaultパスワードを変えても過去の暗号文は守れない)
5. [再暗号化と暗号化の単位](#5-再暗号化と暗号化の単位)
6. [入れ替えをパイプラインに通す](#6-入れ替えをパイプラインに通す)
7. [履歴からの削除は最後の手段](#7-履歴からの削除は最後の手段)
8. [鍵の入れ替えと再生成](#8-鍵の入れ替えと再生成)
9. [入れ替えのコミットをrevertしてはいけない](#9-入れ替えのコミットをrevertしてはいけない)
10. [クラウドでも復旧の考え方は同じ](#10-クラウドでも復旧の考え方は同じ)
11. [まとめ](#11-まとめ)
12. [次回予告](#12-次回予告)
13. [連載一覧：「Ansible×TerraformをGitOpsで回す」](#13-連載一覧ansibleterraformをgitopsで回す)

---

## 1. はじめに

TerraformとAnsibleのパイプラインで、機密情報をAnsible VaultとGitHubのSecretsで扱っていて、

* Vaultパスワードが、漏れたおそれがあると分かった
* すぐにVaultパスワードを新しくし、暗号化した値をすべて再暗号化して、Secretsも書き換えた
* よって、漏れた情報は、もう守られている

と考えていないでしょうか。

Ansible VaultやGitHubのSecretsの入れ替えを扱う記事の多くは、`ansible-vault rekey`でVaultパスワードを変える手順や、Secretsの値を更新する操作を中心にしています。Gitの履歴に残った暗号文、登録した後は読み出せないSecrets、環境ごとに順に進める適用、`git revert`といった、GitOpsのパイプラインの構造が、復旧をどこで難しくするかは、あまり扱われていません。漏れたおそれのある秘密を、パイプラインを動かしたまま入れ替えようとすると、次のような場面にぶつかります。

* Vaultパスワードを新しくしたのに、古いコミットの暗号文を、古いVaultパスワードで復号できた
* Secretsに登録したVaultパスワードを確かめようとしたが、画面には表示されず、手元にも控えがなかった
* 新しいVaultパスワードで暗号化し直したら、プルリクエストの確認が、理由の分からないエラーで止まった
* 接続用の鍵を入れ替えたら、プルリクエストの確認のジョブが、新しい鍵で接続できずに止まった
* 別の不具合でコミットをrevertしたら、漏れたパスワードに戻っていた

これらは、入れ替えの手順の漏れや、操作の順番の誤りに見えます。共通しているのは、Vaultパスワードを変えれば秘密は守られると考え、漏れた秘密の値そのものを入れ替えることと、その入れ替えをパイプラインのどこに通すかを、設計していない点です。

機密情報の扱いは、「AnsibleとTerraformの連携が壊れる理由はライフサイクルにあった」（以下、Ansible×Terraformシリーズ）でも扱ってきました。**[Ansible×Terraformシリーズ第18回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part2/ansible-terraform-part2-18/)** では、Ansible Vaultで暗号化したファイルが、正しいVaultパスワードでなければ復号できないことを確かめたうえで、Vaultパスワード自体をREADMEやチャットに平文で共有する誤用を挙げました。同じ回では、Ansible Vaultは暗号化の手段であって、誰が発行し、誰が使い、いつ失効させるかという機密情報のライフサイクルを管理する仕組みではないと整理しています。これらは、手元からAnsibleを実行する構成での整理で、漏れたVaultパスワードや秘密の値を、どう入れ替えるかは扱っていません。

本シリーズの **[第10回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-10/)** では、mainの1つのコミットを、dev、stg、prodの順にしか適用できない昇格の仕組みを作り、環境ごとに「最後に適用したコミット」を記録しました。**[第11回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-11/)** では、`git revert`で戻るのは、revertの後のコードに元の状態が書かれているものだけであることを確かめ、足したものを取り消すときは、revertではなく「消す」と書いた変更を前に進める設計を整理しました。同じ回では、複数の環境があると、消す変更が一部の環境で飛ばされることも確かめています。

**[第13回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part3/ansible-gitops-part3-13/)** では、機密情報を含むファイルを削除しても、過去のコミットとクローンした先から中身を取り出せ、ブランチを消してもコミットが手元に残ることを確かめ、一度入った機密情報を、履歴とすべての複製から取り除く作業を、この回に送りました。同じ回のセクション6では、Ansible Vaultで暗号化してGitに置く場合、Vaultパスワードが漏れれば、履歴に残った過去の暗号文も、すべての複製で読めることになると整理しています。

**[第14回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part3/ansible-gitops-part3-14/)** では、プルリクエストのレビューで、どの値が変わったかを読み取れるよう、値ごとに暗号化する形を選びました。また、Vault IDを付けて暗号化すると、暗号文のヘッダーに名前が入り、渡したVaultパスワードによって、復号できる値とできない値が分かれることを確かめています。暗号化し忘れた値に気づいたときは、コミットを取り消すのではなく値を入れ替えるとし、入れ替えの手順と、入れ替えた値をどう確かめるかを、この回に送りました。

**[第15回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part3/ansible-gitops-part3-15/)** では、「その秘密が何と一緒に変わるか」を基準に、Gitの中はVault、Gitの外は鍵という2層の役割分担を確定させました。Vaultパスワードは、ツールを動かすための鍵として、GitHubのSecretsと手元の2か所に、同じ値の写しとして置いています。同じ回では、tfstateとイメージの履歴に残って消せない古いパスワードを、新しい値に入れ替えることで無効にしました。接続用の鍵を入れ替えたときは、プルリクエストの確認のジョブが新しい鍵で接続するため、今のコンテナに新しい公開鍵を手で書き足して、移行の間をしのいでいます。

第16回となる今回は、第3部の最終回として、これまでの回で決めた置き場所の秘密が、漏れたとき、失われたときの復旧を扱います。まず、漏洩と破損で、必要な対応と入れ替える順序がどう違うかを整理します。次に、GitHubのSecretsが登録した後は読み出せないことと、Vaultパスワードを変えても、過去のコミットの暗号文は古いVaultパスワードで復号できることを、実機で確かめます。そのうえで、ファイル全体と値ごとの暗号化で、再暗号化の手間がどう違うかを確かめ、**[第14回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part3/ansible-gitops-part3-14/)** の選択の代償を示します。さらに、Vaultパスワードと秘密の値の入れ替えを、プルリクエストと承認ゲートに通し、Vault IDで新旧のVaultパスワードを併用して、dev、stg、prodの順に段階的に切り替えます。入れ替えた値が操作対象に届いたことを、値を表示せずに確かめる方法も扱います。続けて、Gitの履歴から秘密を取り除く作業が、なぜ最後の手段になるのかを、すでに残っているコミットの残り方から整理し、接続用の鍵の入れ替えでは、新旧の鍵を両方受け付ける期間をコードで作ります。最後に、入れ替えのコミットをrevertしてはいけない理由を、**[第11回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-11/)** と接続して整理し、この構造がクラウドのプロバイダーでも変わらないことを示します。

正確に言うと、**機密情報の復旧は、鍵を変えることではありません。秘密の値そのものを入れ替えることであり、その入れ替えも、ほかの変更と同じく、GitOpsのパイプラインを通す必要があります**。この回で扱う問いは、「秘密が漏れたとき、失われたときに、GitOpsの構造はどこで復旧を妨げ、どうすれば安全に入れ替えられるのか」です。

次のセクションでは、漏洩と破損で、必要な対応がどう違うのかを整理します。

---

[↑ 目次に戻る](#-目次)

---

## 2. 漏洩と破損を分ける

機密情報が漏れた場合と、失われた場合とで、必要な対応がどう違うかを整理し、実際に起きたときに、エラーの表示から2つを見分けられるかを確かめます。

### 漏洩は、第三者が秘密を知った状態

漏洩は、本来知るべきでない人が、秘密の値を知った、または知りえた状態です。**[Ansible×Terraformシリーズ第18回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part2/ansible-terraform-part2-18/)** で挙げた、Vaultパスワードをチャットに平文で共有した場合や、**[第14回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part3/ansible-gitops-part3-14/)** のセクション6で扱った、暗号化し忘れた値をプッシュした場合が、これに当たります。

漏れた秘密は、取り戻せません。知られた値を、知られていない状態に戻す方法はないためです。できるのは、その値を使えなくすることだけです。つまり、漏洩への対応は、漏れた値を新しい値に入れ替え、古い値をどこでも通用しない状態にすることです。

入れ替える範囲は、何が漏れたかで変わります。

* 秘密の値が1つ漏れた場合は、読めるのはその値だけで、入れ替えるのもその値だけです
* Vaultパスワードが漏れた場合は、そのVaultパスワードで暗号化したすべての値が読めます。**[第13回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part3/ansible-gitops-part3-13/)** のセクション6で整理したとおり、履歴に残った過去の暗号文も含まれます。入れ替えるのは、Vaultパスワードと、その後ろにあるすべての値です
* 接続用の秘密鍵が漏れた場合は、その鍵で操作対象に入れます。入れ替えるのは、秘密鍵と、操作対象に入っている公開鍵の組です

|漏れたもの|読める値|入れ替えるもの|
|---|---|---|
|秘密の値|その値|その値|
|Vaultパスワード|そのVaultパスワードで暗号化したすべての値（履歴を含む）|Vaultパスワードと、すべての値|
|接続用の秘密鍵|―（その鍵で操作対象に入れる）|秘密鍵と公開鍵の組|

### 破損と紛失は、誰も読めなくなった状態

破損と紛失は、漏洩とは逆に、本来読めるべき人も、秘密の値を読めなくなった状態です。Vaultパスワードを失った場合と、暗号文が壊れた場合が、これに当たります。

秘密は誰にも知られていないため、値を入れ替える必要はありません。必要なのは、元の状態に戻すことです。Vaultパスワードは、控えがあれば戻せます。暗号文は、Gitの履歴に、壊れる前のコミットが残っています。漏洩のときには過去の暗号文を読ませてしまう履歴が、破損のときには、元に戻すための材料になります。

ただし、Vaultパスワードの控えがどこにもなければ、そのVaultパスワードで暗号化したすべての値が、二度と復号できません。その場合は、値そのものを新しく作り直して、操作対象に設定し直すことになり、作業は漏洩のときの入れ替えと同じになります。Vaultパスワードの控えをどこに持つかは、**[セクション3](#3-github-secretsは読み出せない)** で扱います。

### ■ 検証内容：Vaultパスワードの誤りと、暗号文の破損の表示

漏洩と破損は、必要な対応が逆です。ところが、どちらも、パイプラインの上では「復号できない」という同じ形で現れることがあります。漏れた後に入れ替えたVaultパスワードで、入れ替えていない古い暗号文を開こうとした場合と、暗号文が壊れた場合です。この2つを、エラーの表示で見分けられるかを確かめます。

一時ディレクトリに、正しいVaultパスワードと、誤ったVaultパスワードを、どちらもランダムな値で作ります。今の`group_vars`と同じく、ダミーの値を値ごとに暗号化します。

**実行コマンド**

```plaintext
ansible-vault --version | head -1
T=$(mktemp -d)
echo "T=$T"
(umask 077; openssl rand -hex 24 > "$T/pass-correct"; openssl rand -hex 24 > "$T/pass-wrong")
ls -l "$T"
printf -- '---\n' > "$T/vault_ok.yml"
ansible-vault encrypt_string --vault-password-file "$T/pass-correct" --name vault_gitops16_check 'gitops16-section2-dummy' >> "$T/vault_ok.yml" 2>/dev/null
cat -n "$T/vault_ok.yml"
```

**▼ 実行結果**

```plaintext
ansible-vault [core 2.17.14]
T=/tmp/tmp.kyZjPETCJg
total 8
-rw------- 1 control control 49 Oct 20 08:11 pass-correct
-rw------- 1 control control 49 Oct 20 08:11 pass-wrong
     1  ---
     2  vault_gitops16_check: !vault |
     3            $ANSIBLE_VAULT;1.1;AES256
     4            35383962613761636335323062613830376263396331623734376134326565306161633436643130
     5            3638666131303137633862353465653462393134383931360a643430316238626162613362323062
     6            31346533613066336562373334313334336361363461376230323264636365626535346432373337
     7            3336313731366538380a666531623038343532323437393130373332656665373139623835356531
     8            63323033656563666562386532643065316133333033383461633965643735393164
```

暗号文の6行目の先頭の1文字だけを書き換えた写しを作り、壊れた暗号文とします。そのうえで、正しいVaultパスワード、誤ったVaultパスワード、Vaultパスワードを渡さない場合、壊れた暗号文の4つで、復号を試みます。復号した値は表示せず、比較の結果（`true`か`false`）だけを表示します。

**実行コマンド**

```plaintext
sed '6s/^\( *\)3/\14/' "$T/vault_ok.yml" > "$T/vault_broken.yml"
diff "$T/vault_ok.yml" "$T/vault_broken.yml"
echo "== correct"
ansible localhost -i localhost, -c local -m ansible.builtin.debug -a "msg={{ vault_gitops16_check == 'gitops16-section2-dummy' }}" -e @"$T/vault_ok.yml" --vault-password-file "$T/pass-correct" 2>&1; echo "exit_code=$?"
echo "== wrong"
ansible localhost -i localhost, -c local -m ansible.builtin.debug -a "msg={{ vault_gitops16_check == 'gitops16-section2-dummy' }}" -e @"$T/vault_ok.yml" --vault-password-file "$T/pass-wrong" 2>&1; echo "exit_code=$?"
echo "== no password"
ansible localhost -i localhost, -c local -m ansible.builtin.debug -a "msg={{ vault_gitops16_check == 'gitops16-section2-dummy' }}" -e @"$T/vault_ok.yml" 2>&1; echo "exit_code=$?"
echo "== broken"
ansible localhost -i localhost, -c local -m ansible.builtin.debug -a "msg={{ vault_gitops16_check == 'gitops16-section2-dummy' }}" -e @"$T/vault_broken.yml" --vault-password-file "$T/pass-correct" 2>&1; echo "exit_code=$?"
```

**▼ 実行結果**

```plaintext
6c6
<           31346533613066336562373334313334336361363461376230323264636365626535346432373337
---
>           41346533613066336562373334313334336361363461376230323264636365626535346432373337
== correct
localhost | SUCCESS => {
    "msg": true
}
exit_code=0
== wrong
localhost | FAILED! => {
    "msg": "Decryption failed (no vault secrets were found that could decrypt)"
}
exit_code=2
== no password
localhost | FAILED! => {
    "msg": "Attempting to decrypt but no vault secrets found"
}
exit_code=2
== broken
localhost | FAILED! => {
    "msg": "Decryption failed (no vault secrets were found that could decrypt)"
}
exit_code=2
```

確認の後、一時ディレクトリを削除しました。

**実行コマンド**

```plaintext
rm -r "$T"
ls -ld "$T"; echo "ls_exit_code=$?"
unset T
```

**▼ 実行結果**

```plaintext
ls: cannot access '/tmp/tmp.kyZjPETCJg': No such file or directory
ls_exit_code=2
```

### ■ 結果

4つの場合の表示を並べると、次のとおりです。

|場合|表示|
|---|---|
|正しいVaultパスワード|`"msg": true`|
|誤ったVaultパスワード|`Decryption failed (no vault secrets were found that could decrypt)`|
|Vaultパスワードを渡さない|`Attempting to decrypt but no vault secrets found`|
|壊れた暗号文|`Decryption failed (no vault secrets were found that could decrypt)`|

誤ったVaultパスワードと、壊れた暗号文は、まったく同じメッセージでした。どちらも、渡されたVaultパスワードでは、その暗号文を開けなかったことしか示していません。Vaultパスワードを渡さなかった場合だけは、別のメッセージになりました。

**[第12回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-12/)** では、パイプラインが止まったときに、止まったステップとメッセージから、設計どおりの停止か故障かを見分けました。復号の失敗は、メッセージだけでは、Vaultパスワードの誤りなのか、暗号文の破損なのかを見分けられません。一方は、漏洩の後の入れ替えの途中で起きる食い違いで、もう一方は破損です。メッセージから原因を決めつけて対応すると、壊れた暗号文に対してVaultパスワードを入れ替え直す、あるいは、入れ替えの途中の食い違いを、暗号文の復元で直そうとする、といった、逆の対応になりえます。

この検証で2つを分けたのは、同じ正しいVaultパスワードで、壊れていない暗号文（`correct`）は復号でき、壊れた暗号文（`broken`）は復号できなかった、という対比でした。パイプラインでは、1つのVaultパスワードで多くの値を復号しています。同じVaultパスワードで、ほかの値は復号できているのに、特定の値だけが失敗するなら、疑うのはその暗号文です。すべての値が失敗するなら、疑うのはVaultパスワードです。また、値ごとに暗号化した変数は、読み込んだ時点ではなく、その変数を使ったところで失敗として現れました。**[第14回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part3/ansible-gitops-part3-14/)** のセクション7と同じ現れ方です。

### 2つで必要な対応

ここまでを、漏洩と、破損・紛失に分けて並べます。

* 漏洩は、秘密の値を入れ替えて、古い値を通用しなくする。Gitの履歴は、過去の暗号文を読ませてしまうため、漏洩の側では不利に働く
* 破損・紛失は、控えと履歴から元に戻す。値を入れ替える必要はない。ただし、Vaultパスワードの控えがなければ、値を作り直すことになり、漏洩と同じ作業になる

|項目|漏洩|破損・紛失|
|---|---|---|
|起きていること|第三者が秘密を知った|本来読める人も読めなくなった|
|秘密の値|入れ替える|入れ替えない（控えがなければ作り直す）|
|Vaultパスワード|入れ替える|控えから戻す|
|Gitの履歴|過去の暗号文を読ませてしまう|壊れる前の暗号文を取り出せる|
|復号できないときの表示|入れ替えの途中の食い違いで、`Decryption failed`になりうる|暗号文の破損でも、同じ`Decryption failed`になる|

漏洩への対応の中心は、値の入れ替えです。Vaultパスワードを入れ替えるだけで、漏れた値が守られるかどうかは、**[セクション4](#4-vaultパスワードを変えても過去の暗号文は守れない)** で確かめます。何を、どの順に入れ替えるかは、**[セクション6](#6-入れ替えをパイプラインに通す)** で、パイプラインに通しながら確かめます。

次のセクションでは、破損に備えるVaultパスワードの控えについて、GitHubのSecretsが、登録した後は読み出せないことから確かめます。

---

[↑ 目次に戻る](#-目次)

---

## 3. GitHub Secretsは読み出せない

**[セクション2](#2-漏洩と破損を分ける)** で、破損と紛失には、控えから戻すことで対応すると整理しました。ここでは、Vaultパスワードの置き場所の1つであるGitHubのSecretsが、その控えになるかを確かめます。

### Secretsの画面に出るのは、名前と更新時期だけ

**[第13回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part3/ansible-gitops-part3-13/)** のセクション4では、Secretsの一覧に表示されるのが、名前と、おおよその更新時期だけであることを確かめました。**[第14回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part3/ansible-gitops-part3-14/)** のセクション2では、ジョブの中で値を`echo`しても、ログには`***`と表示されることを確かめています。

一覧とログに値が出ないことは分かっています。ここでは、値を書き換えるための編集の画面で、登録した値が表示されるかを確かめます。

### ■ 検証内容：編集の画面で、登録した値が表示されるか

リポジトリの「Settings」→「Secrets and variables」→「Actions」の「Repository secrets」の一覧で、`ANSIBLE_VAULT_PASSWORD`の編集を開きました。

![ANSIBLE_VAULT_PASSWORDの編集の画面。Valueの入力欄は空になっている](/images/blog/infra/ansible/ansible-gitops/ansible-gitops-part3/ansible-gitops-part3-16/section3-secret-edit.png)

「Value」の入力欄は空で、登録した値は表示されませんでした。編集の画面でできるのは、新しい値を入れて上書きすることだけです。画面は、保存せずに閉じています。

### ■ 検証内容：ジョブの中で、手元の控えと照合する

Secretsの値は、画面からは読み出せません。それでも、手元の控えと同じ値かどうかは、確かめておく必要があります。**[第15回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part3/ansible-gitops-part3-15/)** のセクション3で整理したとおり、Vaultパスワードは、Secretsと手元の2か所に置く同じ値の写しで、片方だけが違っていては控えになりません。

そこで、値そのものではなく、値のハッシュ値（SHA-256）で照合します。作業用のブランチ`gitops16-secret-check`に、次のワークフローを置きます。ジョブの中で、`ANSIBLE_VAULT_PASSWORD`の長さと、ハッシュ値の先頭16文字を表示します。

* **ファイル名：`.github/workflows/gitops16-secret-check.yml`**

```yaml
name: Secret Hash Check

on:
  push:
    branches:
      - gitops16-secret-check

jobs:
  secret-hash:
    runs-on: [self-hosted, Linux, X64]
    steps:
      - name: Show secret hash
        env:
          ANSIBLE_VAULT_PASSWORD: ${{ secrets.ANSIBLE_VAULT_PASSWORD }}
        run: |
          echo "length=${#ANSIBLE_VAULT_PASSWORD}"
          echo "sha256=$(printf '%s' "$ANSIBLE_VAULT_PASSWORD" | sha256sum | cut -c1-16)"
```

このワークフローをコミットしてプッシュし、手元の控えからも、同じ方法で長さとハッシュ値を出します。控えの値は、変数に入れるだけで表示しません。

**実行コマンド**

```plaintext
cd ~/iac/docker-lab-ci
git switch -c gitops16-secret-check
cat > .github/workflows/gitops16-secret-check.yml <<'EOF'
（ワークフローの内容。上のファイルと同じ）
EOF
git add .github/workflows/gitops16-secret-check.yml
git commit -m "GitOps第16回: SecretsのVaultパスワードを、手元の控えとハッシュ値で照合する"
git push -u origin gitops16-secret-check
V=$(cat ~/.config/ansible-vault/gitops14-vault-pass)
echo "length=${#V}"
echo "sha256=$(printf '%s' "$V" | sha256sum | cut -c1-16)"
unset V
```

**▼ 実行結果**

```plaintext
Switched to a new branch 'gitops16-secret-check'
[gitops16-secret-check 3c49f41] GitOps第16回: SecretsのVaultパスワードを、手元の控えとハッシュ値で照合する
 1 file changed, 17 insertions(+)
 create mode 100644 .github/workflows/gitops16-secret-check.yml
（途中省略：プッシュの表示）
length=48
sha256=d32e5a52d0aa2342
```

このプッシュで、「Secret Hash Check」の実行#1が起動し、`secret-hash`ジョブが成功しました。

**▼ 実行結果**（「Secret Hash Check」の実行#1、`secret-hash`ジョブのステップ「Show secret hash」から抜粋）

```plaintext
（途中省略：実行したスクリプト、シェルの表示）
env:
  ANSIBLE_VAULT_PASSWORD: ***
length=48
sha256=d32e5a52d0aa2342
```

確認の後、作業用のブランチを削除しました。

**実行コマンド**

```plaintext
git switch main
git branch -D gitops16-secret-check
git push origin --delete gitops16-secret-check
git branch -a
git status --short; echo "git_status_exit_code=$?"
git log --oneline -1
```

**▼ 実行結果**

```plaintext
Switched to branch 'main'
Your branch is up to date with 'origin/main'.
Deleted branch gitops16-secret-check (was 3c49f41).
To https://github.com/juehara-crypto/ansible-terraform-ci-lab.git
 - [deleted]         gitops16-secret-check
* main
  remotes/origin/main
git_status_exit_code=0
29aa5b3 (HEAD -> main, origin/main) Merge pull request #74 from juehara-crypto/gitops15-secrets-placement
```

### ■ 結果

|確かめた場所|値|長さとハッシュ値|
|---|---|---|
|編集の画面|表示されない（入力欄が空）|―|
|ジョブのログ|`***`に伏せられる|`length=48`、`sha256=d32e5a52d0aa2342`|
|手元の控え|（表示していない）|`length=48`、`sha256=d32e5a52d0aa2342`|

Secretsに登録した値は、編集の画面でも表示されませんでした。一方、ジョブの中のハッシュ値と長さは、手元の控えと一致しました。値を読み出さずに、2か所の写しが同じ値であることを確かめられたことになります。ハッシュ値は伏せ字の対象ではありませんが、ランダムな48文字の値のハッシュ値から、元の値を求めることはできません。ただし、短い値や推測しやすい値では、候補を順にハッシュ値と比べることで、元の値が分かってしまいます。この照合の方法が使えるのは、Vaultパスワードのように、ランダムに作った値に限られます。

### 読み出せないことは、守りにも控えにもならない

Secretsの値が画面から読み出せないことは、一見、守りが固いように見えます。しかし、**[第15回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part3/ansible-gitops-part3-15/)** のセクション5で確かめたとおり、ワークフローを書ける人は、どのジョブにもSecretsの値を渡せます。ジョブの中では、値はそのまま使えます。読み出せないのは画面からであって、ワークフローを書ける人からではありません。

一方で、読み出せないことは、Secretsが控えにならないことを意味します。手元の控えを失ったときに、Secretsから値を取り出して戻すことはできません。Secretsにしか置いていなければ、Secretsの値を誤って上書きしたり、削除したりした時点で、そのVaultパスワードで暗号化したすべての値は、ランナーの外では二度と復号できなくなります。**[セクション2](#2-漏洩と破損を分ける)** で整理したとおり、その場合は値そのものを作り直すことになり、作業は漏洩のときの入れ替えと同じになります。

|置き場所|ジョブから使えるか|人が読み出せるか|控えになるか|
|---|---|---|---|
|GitHubのSecrets|使える|読み出せない（ハッシュ値で照合はできる）|ならない|
|手元の控え|使えない|読み出せる|なる|

### 控えは、GitHubの外に持つ

Vaultパスワードの控えは、Secretsとは別に、GitHubの外に持つ必要があります。**[第4回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part1/ansible-gitops-part1-04/)** のセクション6で整理した信頼の境界で言えば、控えは、GitHubに預けたものとは別の場所にあって初めて、GitHubの側で失ったものを戻す材料になります。

ただし、この検証環境の手元の控え（`~/.config/ansible-vault/`）は、self-hostedランナーと同じホストの上にあります。ホストそのものを失えば、手元の控えも失われ、残るのは読み出せないSecretsだけです。破損に備える控えは、少なくとも1つを、ランナーのホストとも別の場所（パスワード管理ツールや、クラウドのシークレット管理サービスなど）に置く必要があります。どこに置くかは、その置き場所を誰が読めるかという、**[第4回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part1/ansible-gitops-part1-04/)** と同じ基準で選びます。

次のセクションでは、Vaultパスワードを新しくしても、過去のコミットの暗号文が古いVaultパスワードで復号できることを確かめます。

---

[↑ 目次に戻る](#-目次)

---

## 4. Vaultパスワードを変えても過去の暗号文は守れない

Vaultパスワードを新しくして、暗号化した値を再暗号化したときに、Gitの履歴に残った古い暗号文がどうなるかを確かめます。

### 再暗号化が変えるのは、今のファイルだけ

Vaultパスワードが漏れたとき、最初に思いつくのは、Vaultパスワードを新しくし、暗号化した値をすべて新しいVaultパスワードで暗号化し直すことです。再暗号化したファイルをコミットすれば、リポジトリの今の暗号文は、新しいVaultパスワードでしか開けなくなります。

ただし、**[第13回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part3/ansible-gitops-part3-13/)** のセクション3で確かめたとおり、新しいコミットは、それより前のコミットを書き換えません。古いVaultパスワードで暗号化した暗号文は、再暗号化する前のコミットに、そのまま残ります。同じ回のセクション6では、Vaultパスワードが漏れれば、履歴に残った過去の暗号文も、すべての複製で読めることになると整理しました。ここでは、そのことを実機で確かめます。

### ■ 検証内容：再暗号化した後に、古いコミットの暗号文を復号する

手元の作業用のブランチで、ダミーの値を古いVaultパスワードで暗号化してコミットし、続けて同じ値を新しいVaultパスワードで暗号化し直してコミットします。2つのVaultパスワードは、一時ディレクトリにランダムな値で作り、表示しません。このブランチはプッシュしません。

**実行コマンド**

```plaintext
cd ~/iac/docker-lab-ci
git switch -c gitops16-rekey-history
T=$(mktemp -d)
(umask 077; openssl rand -hex 24 > "$T/pass-old"; openssl rand -hex 24 > "$T/pass-new")
mkdir -p ansible/gitops16
printf -- '---\n' > ansible/gitops16/vault_history.yml
ansible-vault encrypt_string --vault-password-file "$T/pass-old" --name vault_gitops16_history 'gitops16-section4-dummy' >> ansible/gitops16/vault_history.yml 2>/dev/null
git add ansible/gitops16/vault_history.yml
git commit -q -m "GitOps第16回: 古いVaultパスワードで暗号化した値（プッシュしない）"
printf -- '---\n' > ansible/gitops16/vault_history.yml
ansible-vault encrypt_string --vault-password-file "$T/pass-new" --name vault_gitops16_history 'gitops16-section4-dummy' >> ansible/gitops16/vault_history.yml 2>/dev/null
git add ansible/gitops16/vault_history.yml
git commit -q -m "GitOps第16回: 新しいVaultパスワードで暗号化し直した値（プッシュしない）"
git log --oneline -3
git --no-pager diff --stat HEAD~1 HEAD
```

**▼ 実行結果**

```plaintext
Switched to a new branch 'gitops16-rekey-history'
b87850b (HEAD -> gitops16-rekey-history) GitOps第16回: 新しいVaultパスワードで暗号化し直した値（プッシュしない）
42052e2 GitOps第16回: 古いVaultパスワードで暗号化した値（プッシュしない）
29aa5b3 (origin/main, main) Merge pull request #74 from juehara-crypto/gitops15-secrets-placement
 ansible/gitops16/vault_history.yml | 10 +++++-----
 1 file changed, 5 insertions(+), 5 deletions(-)
```

`42052e2`が古いVaultパスワードの暗号文、`b87850b`が新しいVaultパスワードで暗号化し直した暗号文です。1つ前のコミット`42052e2`の暗号文を`git show`で一時ディレクトリに取り出し、今のファイルと、取り出した暗号文のそれぞれを、新旧2つのVaultパスワードで復号します。復号した値は表示せず、比較の結果だけを表示します。

**実行コマンド**

```plaintext
git show 42052e2:ansible/gitops16/vault_history.yml > "$T/from_42052e2.yml"
for f in ansible/gitops16/vault_history.yml "$T/from_42052e2.yml"; do
  for p in pass-new pass-old; do
    echo "== $(basename "$f") with $p"
    ansible localhost -i localhost, -c local -m ansible.builtin.debug -a "msg={{ vault_gitops16_history == 'gitops16-section4-dummy' }}" -e @"$f" --vault-password-file "$T/$p" 2>&1 | grep -E '"msg"'
  done
done
```

**▼ 実行結果**

```plaintext
== vault_history.yml with pass-new
    "msg": true
== vault_history.yml with pass-old
    "msg": "Decryption failed (no vault secrets were found that could decrypt)"
== from_42052e2.yml with pass-new
    "msg": "Decryption failed (no vault secrets were found that could decrypt)"
== from_42052e2.yml with pass-old
    "msg": true
```

確認の後、mainに戻って作業用のブランチを削除し、一時ディレクトリを消しました。

**実行コマンド**

```plaintext
git switch main
git branch -D gitops16-rekey-history
ls -d ansible/gitops16; echo "ls_exit_code=$?"
git status --short; echo "git_status_exit_code=$?"
git log --oneline -1
git cat-file -t 42052e2; echo "cat_file_exit_code=$?"
rm -r "$T"
ls -ld "$T"; echo "ls_exit_code=$?"
unset T
```

**▼ 実行結果**

```plaintext
Switched to branch 'main'
Your branch is up to date with 'origin/main'.
Deleted branch gitops16-rekey-history (was b87850b).
ls: cannot access 'ansible/gitops16': No such file or directory
ls_exit_code=2
git_status_exit_code=0
29aa5b3 (HEAD -> main, origin/main) Merge pull request #74 from juehara-crypto/gitops15-secrets-placement
commit
cat_file_exit_code=0
ls: cannot access '/tmp/tmp.tAQD7Mlxeu': No such file or directory
ls_exit_code=2
```

### ■ 結果

2つの暗号文と、2つのVaultパスワードの組み合わせを並べると、次のとおりです。

|暗号文|新しいVaultパスワード|古いVaultパスワード|
|---|---|---|
|今のファイル（`b87850b`）|復号できた|復号できない|
|1つ前のコミット（`42052e2`）|復号できない|復号できた|

再暗号化した今のファイルは、新しいVaultパスワードでしか開けなくなりました。一方、再暗号化する前のコミットの暗号文は、古いVaultパスワードで、今も復号できました。Vaultパスワードを新しくしても、Gitの履歴に残った過去の暗号文は、古いVaultパスワードのまま守られていません。

作業用のブランチを削除した後も、`git cat-file -t 42052e2`は`commit`を表示しました。**[第13回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part3/ansible-gitops-part3-13/)** のセクション3と同じく、ブランチを消しても、コミットは手元のリポジトリから、すぐには消えません。このブランチはプッシュしていないため、残っているのは手元だけです。プッシュしたコミットであれば、GitHubと、すべてのクローンと、チェックアウトしたランナーの作業ディレクトリにも、同じ暗号文が残ります。

### 再暗号化は、漏れた値を変えない

この検証では、同じダミーの値を、2つのVaultパスワードで暗号化しました。再暗号化は、暗号文を作り直すだけで、中身の値は変えません。

古いVaultパスワードが漏れていれば、漏れた時点で、そのVaultパスワードで暗号化していたすべての値は、履歴の暗号文から読めます。その値を新しいVaultパスワードで暗号化し直しても、読まれた値は、読まれたまま使われ続けます。守られるのは、再暗号化した後に、新しく暗号化する値だけです。

そのため、Vaultパスワードが漏れたときに必要なのは、Vaultパスワードの入れ替えに加えて、そのVaultパスワードで暗号化していた値そのものの入れ替えです。**[第15回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part3/ansible-gitops-part3-15/)** のセクション4では、tfstateとイメージの履歴から消せない古いパスワードを、新しい値に入れ替えることで、どのコンテナでも使われていない値にしました。履歴に残る暗号文も、同じ考え方で扱います。履歴から読めてしまう値を消すことはできなくても、その値を、どこでも通用しない値にはできます。

|対応|今の暗号文|履歴に残った暗号文|漏れた値|
|---|---|---|---|
|Vaultパスワードだけを入れ替える|新しいVaultパスワードで守られる|古いVaultパスワードで読める|使われ続ける|
|値そのものも入れ替える|新しいVaultパスワードで守られる|古いVaultパスワードで読める|もう使われていない|

値そのものの入れ替えは、**[セクション6](#6-入れ替えをパイプラインに通す)** で、パイプラインに通しながら確かめます。

次のセクションでは、Vaultパスワードを入れ替えるときに必要な再暗号化の手間が、ファイル全体の暗号化と、値ごとの暗号化で、どう違うかを確かめます。

---

[↑ 目次に戻る](#-目次)

---

## 5. 再暗号化と暗号化の単位

Vaultパスワードを入れ替えるときの再暗号化の手間が、ファイル全体の暗号化と、値ごとの暗号化で、どう違うかを確かめます。

### 値ごとの暗号化は、レビューのために選んだ

**[第14回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part3/ansible-gitops-part3-14/)** のセクション4では、ファイル全体を暗号化すると、1つの値を変えただけでも暗号文がすべて入れ替わり、プルリクエストの差分から、どの変数が変わったかを読み取れないことを確かめました。そこで、値ごとに暗号化する形を選び、今の`group_vars`の`vault_ansible_user_password`も、この形で置いています。**[Ansible×Terraformシリーズ第18回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-terraform/ansible-terraform-part2/ansible-terraform-part2-18/)** でも、値ごとの暗号化は、1つの値を変えるときに、その値だけを暗号化し直せばよいとしていました。

どちらも、値を変えるときの話です。Vaultパスワードを入れ替えるときは、値は変えずに、すべての値を新しいVaultパスワードで暗号化し直すことになります。Ansible Vaultには、Vaultパスワードを切り替える`ansible-vault rekey`があります。この`rekey`が、2つの単位でどう働くかを確かめます。

### ■ 検証内容：2つの単位のファイルに、rekeyをかける

一時ディレクトリに、古いVaultパスワードと新しいVaultパスワードを、ランダムな値で作ります。同じ中身（暗号化しない変数`gitops16_mode`と、暗号化する変数2つ）を、ファイル全体の暗号化（`vault_file.yml`）と、値ごとの暗号化（`vault_string.yml`）で、古いVaultパスワードを使って作ります。ファイル全体を暗号化するときの平文は、暗号化した直後に消します。

**実行コマンド**

```plaintext
cd ~/iac/docker-lab-ci/ansible
T=$(mktemp -d)
(umask 077; openssl rand -hex 24 > "$T/pass-old"; openssl rand -hex 24 > "$T/pass-new")
printf -- '---\ngitops16_mode: check\nvault_gitops16_db: gitops16-section5-db\nvault_gitops16_api: gitops16-section5-api\n' > "$T/plain.yml"
ansible-vault encrypt --vault-password-file "$T/pass-old" --output "$T/vault_file.yml" "$T/plain.yml"
rm "$T/plain.yml"
printf -- '---\ngitops16_mode: check\n' > "$T/vault_string.yml"
ansible-vault encrypt_string --vault-password-file "$T/pass-old" --name vault_gitops16_db 'gitops16-section5-db' >> "$T/vault_string.yml" 2>/dev/null
ansible-vault encrypt_string --vault-password-file "$T/pass-old" --name vault_gitops16_api 'gitops16-section5-api' >> "$T/vault_string.yml" 2>/dev/null
ls -l "$T"
head -1 "$T/vault_file.yml"
```

**▼ 実行結果**

```plaintext
Encryption successful
total 16
-rw------- 1 control control   49 Oct 20 08:51 pass-new
-rw------- 1 control control   49 Oct 20 08:51 pass-old
-rw------- 1 control control  743 Oct 20 08:51 vault_file.yml
-rw-rw-r-- 1 control control 1040 Oct 20 08:51 vault_string.yml
$ANSIBLE_VAULT;1.1;AES256
```

値ごとに暗号化したファイルの、変数名の行と暗号文のヘッダーの行を表示したうえで、2つのファイルに`ansible-vault rekey`をかけます。そのあと、2つのファイルを、新旧2つのVaultパスワードで復号します。

**実行コマンド**

```plaintext
grep -nE '^[A-Za-z0-9_]+:|ANSIBLE_VAULT' "$T/vault_string.yml"
for f in vault_file vault_string; do
  echo "== rekey $f"
  ansible-vault rekey --vault-password-file "$T/pass-old" --new-vault-password-file "$T/pass-new" "$T/$f.yml" 2>&1; echo "rekey_exit_code=$?"
done
for f in vault_file vault_string; do
  for p in pass-new pass-old; do
    echo "== $f with $p"
    ansible localhost -i localhost, -c local -m ansible.builtin.debug -a "msg={{ vault_gitops16_db == 'gitops16-section5-db' and vault_gitops16_api == 'gitops16-section5-api' }}" -e @"$T/$f.yml" --vault-password-file "$T/$p" 2>&1 | grep -E '"msg"'
  done
done
```

**▼ 実行結果**

```plaintext
2:gitops16_mode: check
3:vault_gitops16_db: !vault |
4:          $ANSIBLE_VAULT;1.1;AES256
10:vault_gitops16_api: !vault |
11:          $ANSIBLE_VAULT;1.1;AES256
== rekey vault_file
Rekey successful
rekey_exit_code=0
== rekey vault_string
ERROR! input is not vault encrypted data.  for /tmp/tmp.f2OvuUxb6p/vault_string.yml
rekey_exit_code=1
== vault_file with pass-new
    "msg": true
== vault_file with pass-old
== vault_string with pass-new
    "msg": "Decryption failed (no vault secrets were found that could decrypt)"
== vault_string with pass-old
    "msg": true
```

`vault_file with pass-old`には、`"msg"`の行がありません。絞り込まずに、もう一度表示します。

**実行コマンド**

```plaintext
ansible localhost -i localhost, -c local -m ansible.builtin.debug -a "msg={{ vault_gitops16_db == 'gitops16-section5-db' and vault_gitops16_api == 'gitops16-section5-api' }}" -e @"$T/vault_file.yml" --vault-password-file "$T/pass-old" 2>&1; echo "exit_code=$?"
```

**▼ 実行結果**

```plaintext
[WARNING]:  * Failed to parse localhost, with host_list plugin: Decryption failed (no vault secrets were found that could decrypt) on /tmp/tmp.f2OvuUxb6p/vault_file.yml
[WARNING]: Unable to parse localhost, as an inventory source
ERROR! No inventory was parsed, please check your configuration and options.
exit_code=1
```

### ■ 結果

|ファイル|`rekey`|新しいVaultパスワード|古いVaultパスワード|
|---|---|---|---|
|`vault_file.yml`（ファイル全体）|成功|復号できた|読み込みの時点で失敗|
|`vault_string.yml`（値ごと）|`input is not vault encrypted data`で失敗|復号できない|復号できた|

ファイル全体を暗号化したファイルは、`rekey`の1回で、新しいVaultパスワードでしか開けないファイルに切り替わりました。値ごとに暗号化したファイルは、ファイルそのものはVaultの暗号文ではないため、`rekey`の対象になりませんでした。古いVaultパスワードのまま残っています。

もう1つ、失敗の現れ方も違いました。ファイル全体の暗号化を古いVaultパスワードで読むと、`Decryption failed`は、`Failed to parse localhost, with host_list plugin`という、インベントリの読み込みの失敗の形で現れ、`No inventory was parsed`で止まりました。`-e`で渡した変数ファイルの復号に失敗したのに、表示はインベントリの誤りに見えます。値ごとの暗号化では、**[セクション2](#2-漏洩と破損を分ける)** のとおり、変数を使ったタスクの失敗として現れていました。復号の失敗の表示は、暗号化の単位によっても変わります。

### ■ 検証内容：値ごとの暗号化を、新しいVaultパスワードに切り替える

値ごとに暗号化したファイルを、新しいVaultパスワードに切り替える手順を確かめます。手順は、次のとおりです。

1. 暗号化していない行だけを、新しいファイルに写す
2. 暗号化した変数ごとに、暗号文を取り出し、字下げを外して、Vaultの暗号文のファイルにする
3. 取り出した暗号文を、古いVaultパスワードで復号し、そのまま新しいVaultパスワードで暗号化し直して、新しいファイルに足す

復号した値は、パイプの中で次のコマンドに渡すだけで、画面にもファイルにも出しません。

**実行コマンド**

```plaintext
src="$T/vault_string.yml"; dst="$T/vault_string_rekeyed.yml"
awk '/^[A-Za-z0-9_]+: !vault \|$/{skip=1; next} skip && /^ /{next} {skip=0; print}' "$src" > "$dst"
for n in $(sed -n 's/^\([A-Za-z0-9_]*\): !vault |$/\1/p' "$src"); do
  echo "== re-encrypt $n"
  awk -v n="$n" '$0==n": !vault |"{f=1; next} f && /^ /{sub(/^ +/,""); print; next} f{exit}' "$src" > "$T/$n.enc"
  ansible-vault decrypt --vault-password-file "$T/pass-old" --output - "$T/$n.enc" 2>/dev/null | ansible-vault encrypt_string --vault-password-file "$T/pass-new" --stdin-name "$n" >> "$dst" 2>/dev/null
  rm "$T/$n.enc"
done
grep -nE '^[A-Za-z0-9_]+:|ANSIBLE_VAULT' "$dst"
for p in pass-new pass-old; do
  echo "== vault_string_rekeyed with $p"
  ansible localhost -i localhost, -c local -m ansible.builtin.debug -a "msg={{ vault_gitops16_db == 'gitops16-section5-db' and vault_gitops16_api == 'gitops16-section5-api' }}" -e @"$dst" --vault-password-file "$T/$p" 2>&1 | grep -E '"msg"'
done
```

**▼ 実行結果**

```plaintext
== re-encrypt vault_gitops16_db
== re-encrypt vault_gitops16_api
2:gitops16_mode: check
3:vault_gitops16_db: !vault |
4:          $ANSIBLE_VAULT;1.1;AES256
10:vault_gitops16_api: !vault |
11:          $ANSIBLE_VAULT;1.1;AES256
== vault_string_rekeyed with pass-new
    "msg": true
== vault_string_rekeyed with pass-old
    "msg": "Decryption failed (no vault secrets were found that could decrypt)"
```

確認の後、一時ディレクトリを削除しました。

**実行コマンド**

```plaintext
rm -r "$T"
ls -ld "$T"; echo "ls_exit_code=$?"
unset T src dst n
```

**▼ 実行結果**

```plaintext
ls: cannot access '/tmp/tmp.f2OvuUxb6p': No such file or directory
ls_exit_code=2
```

### ■ 結果

切り替えた後のファイルは、元と同じ構造（暗号化しない`gitops16_mode`と、2つの変数名）のまま、新しいVaultパスワードでしか復号できないファイルになりました。値ごとの暗号化でも、Vaultパスワードは切り替えられます。ただし、`rekey`の1回では済まず、変数の数だけ、暗号文を取り出し、復号し、暗号化し直して、ファイルを組み立て直す手順が要りました。

2つの単位を、Vaultパスワードを入れ替えるときの手間で並べます。

* ファイル全体の暗号化は、`rekey`の1回で切り替わる。平文は`rekey`の中だけにあり、外には出ない
* 値ごとの暗号化は、`rekey`の対象にならず、変数ごとに復号と暗号化を繰り返す手順を、自分で用意する必要がある。復号した値は、手順の書き方しだいで、画面や一時ファイルに出うる

|項目|ファイル全体の暗号化|値ごとの暗号化|
|---|---|---|
|1つの値を変える|ファイル全体を復号し、編集し、暗号化し直す|その値だけを暗号化し直す|
|Vaultパスワードを入れ替える|`rekey`の1回|変数ごとに、取り出し、復号し、暗号化し直す|
|プルリクエストの差分（値を変えたとき）|どの変数が変わったか分からない（**[第14回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part3/ansible-gitops-part3-14/)**）|変わった変数が分かる（**[第14回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part3/ansible-gitops-part3-14/)**）|
|復号に失敗したとき|読み込みの時点で止まる。この検証環境では、インベントリの誤りに見える表示になった|その変数を使ったタスクの失敗として現れる|

### 値の変更と鍵の変更は、手間が逆になる

値ごとの暗号化は、値を変えるときには手間が少なく、Vaultパスワードを入れ替えるときには手間が多くなりました。ファイル全体の暗号化は、その逆です。**[第14回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part3/ansible-gitops-part3-14/)** の選択は、プルリクエストのレビューを優先した結果で、その代償が、ここで現れています。

ただし、この代償が重くなる場面は、限られます。**[セクション4](#4-vaultパスワードを変えても過去の暗号文は守れない)** で整理したとおり、Vaultパスワードが漏れたときは、値そのものも入れ替えます。新しい値を、新しいVaultパスワードで暗号化するので、古い値を復号して暗号化し直す必要はありません。古い値を暗号化し直す手順が要るのは、漏洩ではない理由で、値を変えずにVaultパスワードだけを入れ替えるときです。たとえば、Vaultパスワードを知っている人が担当から外れたときや、決めた期間ごとに入れ替える運用にしているときです。

Vaultパスワードの入れ替えは、値の変更より頻度が低く、そのぶん、手順も慣れないまま実行することになります。値ごとに暗号化する形を選ぶなら、この検証のような切り替えの手順を、使う前に用意して試しておく必要があります。この検証環境では、暗号化した値は、3つの環境の`group_vars`に1つずつ（`vault_ansible_user_password`）しかありません。暗号化した値が増えるほど、この手順の手間も増えていきます。

次のセクションでは、Vaultパスワードと、`ansible`のパスワードの値そのものの入れ替えを、プルリクエストと承認ゲートに通し、Vault IDで新旧のVaultパスワードを併用しながら、段階的に切り替えます。

---

[↑ 目次に戻る](#-目次)

---

## 6. 入れ替えをパイプラインに通す

漏れた値と、Vaultパスワードの両方を入れ替える作業を、プルリクエストと承認ゲートに通します。Vault IDで新旧2つのVaultパスワードを併用する移行期間を作り、dev→stg→prodの順に、値を入れ替えます。

### Vaultパスワードの置き場所は2つあり、同時には変えられない

**[第14回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part3/ansible-gitops-part3-14/)** の構成では、Vaultパスワードは、GitHubのSecrets（`ANSIBLE_VAULT_PASSWORD`）に置き、暗号文は、Gitの`group_vars`に置いています。Vaultパスワードを入れ替えるには、この2か所を両方変える必要があります。

2か所は、変わり方が違います。**[第10回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-10/)** で整理したとおり、Secretsはリポジトリに1つで、値を上書きした瞬間に、すべての環境の、すべてのジョブに効きます。一方、Gitの暗号文は、プルリクエストを通してmainに入り、承認ゲートを通って、dev→stg→prodの順に適用されます。

* Secretsの値だけを先に上書きすると、まだ古い暗号文を使っている、すべての確認と適用が、復号に失敗する
* Gitの暗号文だけを先に変えると、そのプルリクエストの確認が、古いVaultパスワードで新しい暗号文を開こうとして、復号に失敗する

どちらを先にしても、片方が追いつくまでの間、パイプラインが止まります。2か所を同時に変える方法はありません。そこで、新旧2つのVaultパスワードを、両方受け付ける期間を作ります。Ansibleでは、Vault IDで、複数のVaultパスワードを並べて渡せます（**[第14回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part3/ansible-gitops-part3-14/)** のセクション5）。

### 入れ替えの手順

この検証では、次の順に進めます。

|段階|内容|
|---|---|
|1|新しいVaultパスワードを作り、新しい名前のSecret（`ANSIBLE_VAULT_PASSWORD_GITOPS16`）に登録する。今の`ANSIBLE_VAULT_PASSWORD`は残す|
|2|`ansible`のパスワードを新しい値にし、新しいVaultパスワード（Vault ID`gitops16`）で暗号化したプルリクエストを出す|
|3|ワークフローを、Vault IDで新旧2つのVaultパスワードを渡す形に変える|
|4|段階2のプルリクエストをマージし、dev→stg→prodの順に適用する|
|5|3環境の`gitops.applied`に記録されたのを確かめてから、古いVault IDを外し、古いSecretを削除する|

段階2で、ワークフローを変える前の状態で確認を動かし、Gitの暗号文だけを先に変えたときに何が起きるかを確かめます。

### ■ 検証内容：Gitの暗号文だけを先に変える

新しいVaultパスワードを、手元にランダムな値で作ります。作ったファイルの値をコピーし、GitHubの「Repository secrets」に、`ANSIBLE_VAULT_PASSWORD_GITOPS16`の名前で登録しました。

**実行コマンド**

```plaintext
(umask 077; openssl rand -hex 24 > ~/.config/ansible-vault/gitops16-vault-pass)
ls -l ~/.config/ansible-vault
wc -c < ~/.config/ansible-vault/gitops16-vault-pass
```

**▼ 実行結果**

```plaintext
total 8
-rw------- 1 control control 49 Oct 16 01:07 gitops14-vault-pass
-rw------- 1 control control 49 Oct 20 09:07 gitops16-vault-pass
49
```

作業用のブランチで、3環境の`vault_ansible_user_password`を、新しいランダムな値に入れ替えます。作った値は画面にもファイルにも出さず、そのまま`encrypt_string`に渡し、Vault ID`gitops16`で暗号化します。そのうえで、手元で新旧2つのVaultパスワードで復号できるかを、値の長さだけで確かめます。

**実行コマンド**

```plaintext
cd ~/iac/docker-lab-ci
git switch -c gitops16-rotate-values
VP16=~/.config/ansible-vault/gitops16-vault-pass
VP14=~/.config/ansible-vault/gitops14-vault-pass
for e in dev stg prod; do
  f=ansible/inventories/$e/group_vars/target_nodes.yml
  sed -i '/^vault_ansible_user_password: !vault |$/,$d' "$f"
  (P=$(openssl rand -hex 16); printf '%s' "$P" | ansible-vault encrypt_string --vault-id "gitops16@$VP16" --stdin-name vault_ansible_user_password >> "$f" 2>/dev/null)
done
git --no-pager diff --stat
for e in dev stg prod; do echo "== $e"; sed -n '1,5p' ansible/inventories/$e/group_vars/target_nodes.yml; done
cd ansible
for e in dev stg prod; do
  for id in "gitops16@$VP16" "gitops14@$VP14"; do
    echo "== $e with ${id%%@*}"
    ansible localhost -i localhost, -c local -m ansible.builtin.debug -a "msg={{ vault_ansible_user_password | length }}" -e @inventories/$e/group_vars/target_nodes.yml --vault-id "$id" 2>&1 | grep -E '"msg"'
  done
done
cd ..
```

**▼ 実行結果**

```plaintext
Switched to a new branch 'gitops16-rotate-values'
 ansible/inventories/dev/group_vars/target_nodes.yml  | 14 +++++++-------
 ansible/inventories/prod/group_vars/target_nodes.yml | 14 +++++++-------
 ansible/inventories/stg/group_vars/target_nodes.yml  | 14 +++++++-------
 3 files changed, 21 insertions(+), 21 deletions(-)
== dev
---
common_setup_env: dev
common_setup_ansible_user_password: "{{ vault_ansible_user_password }}"
vault_ansible_user_password: !vault |
          $ANSIBLE_VAULT;1.2;AES256;gitops16
（途中省略：stg、prodも同じヘッダー）
== dev with gitops16
    "msg": "32"
== dev with gitops14
    "msg": "Decryption failed (no vault secrets were found that could decrypt)"
== stg with gitops16
    "msg": "32"
== stg with gitops14
    "msg": "Decryption failed (no vault secrets were found that could decrypt)"
== prod with gitops16
    "msg": "32"
== prod with gitops14
    "msg": "Decryption failed (no vault secrets were found that could decrypt)"
```

ヘッダーが、Vault IDなしの`1.1`から、`1.2;AES256;gitops16`に変わりました。新しい暗号文は、新しいVaultパスワードでだけ復号できます。これをコミットしてプッシュし、プルリクエスト（PR#76）を作りました。

**実行コマンド**

```plaintext
git add ansible/inventories/dev/group_vars/target_nodes.yml ansible/inventories/stg/group_vars/target_nodes.yml ansible/inventories/prod/group_vars/target_nodes.yml
git commit -m "GitOps第16回: ansibleのパスワードを新しい値にし、新しいVaultパスワード（gitops16）で暗号化する"
git push -u origin gitops16-rotate-values
```

**▼ 実行結果**

```plaintext
[gitops16-rotate-values 1c2ec24] GitOps第16回: ansibleのパスワードを新しい値にし、新しいVaultパスワード（gitops16）で暗号化する
 3 files changed, 33 insertions(+), 33 deletions(-)
（以降省略）
```

PR#76の確認の実行（「GitOps Pipeline」の実行#138）では、`ansible-lint`と`molecule`は成功し、`ansible-check`が失敗しました。

**▼ 実行結果**（「GitOps Pipeline」の実行#138、`ansible-check`ジョブから抜粋）

```plaintext
  ansible-playbook -i "inventories/$e" site.yml --check --diff --vault-password-file ../.github/scripts/vault-pass.sh
（途中省略）
== dev
（途中省略）
TASK [common_setup : ユーザーansibleのパスワードを設定] ************************
fatal: [dev-node1]: FAILED! => {"censored": "the output has been hidden due to the fact that 'no_log: true' was specified for this result"}

PLAY RECAP *********************************************************************
dev-node1                  : ok=4    changed=0    unreachable=0    failed=1    skipped=0    rescued=0    ignored=0   

##[error]Process completed with exit code 2.
```

### ■ 結果

Gitの暗号文だけを先に変えると、確認の実行は、devのパスワードのタスクで止まりました。ワークフローは、まだ`vault-pass.sh`で古いVaultパスワードだけを渡しているため、新しい暗号文を開けません。devで止まったため、stgとprodの確認は動いていません（**[第12回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-12/)** と同じ動きです）。

ここで見落とせないのは、表示が`censored`だけだったことです。**[セクション2](#2-漏洩と破損を分ける)** では、復号に失敗すると`Decryption failed`と表示されました。しかし、パスワードを設定するタスクには`no_log: true`を付けているため、失敗の理由そのものが伏せられます。**[第15回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part3/ansible-gitops-part3-15/)** のセクション4で、`passlib`がなかったときに見たのと、同じ表示です。秘密の値を守るための`no_log`は、秘密にかかわる失敗の手がかりも隠します。

### ■ 検証内容：Vault IDで、新旧2つのVaultパスワードを渡す

ワークフローから、新旧2つのVaultパスワードを渡せるようにします。今の`vault-pass.sh`は、環境変数`ANSIBLE_VAULT_PASSWORD`の値を1つ出すだけです。Ansibleは、名前が`-client`で終わるスクリプトに、`--vault-id`の名前を引数で渡します。これを使い、Vault IDの名前に応じて、`ANSIBLE_VAULT_PASSWORD_<IDの大文字>`の環境変数を出すスクリプトを作ります。

* **ファイル名：`.github/scripts/vault-pass-client.sh`**

```bash
#!/usr/bin/env bash
# --vault-id <ID> を受け取り、環境変数 ANSIBLE_VAULT_PASSWORD_<IDの大文字> の値を、Vaultパスワードとして標準出力に出す
set -euo pipefail
id=""
while [ $# -gt 0 ]; do
  case "$1" in
    --vault-id) id="${2:-}"; shift 2 ;;
    *) shift ;;
  esac
done
if [ -z "$id" ]; then
  echo "vault id is not given" >&2
  exit 1
fi
var="ANSIBLE_VAULT_PASSWORD_$(printf '%s' "$id" | tr '[:lower:]' '[:upper:]')"
if [ -z "${!var:-}" ]; then
  echo "$var is not set" >&2
  exit 1
fi
printf '%s\n' "${!var}"
```

手元で、今のmainの暗号文（Vault IDなし）と、PR#76の暗号文（Vault ID`gitops16`）が、このスクリプトと2つのVault IDで復号できるかを確かめます。

**実行コマンド**

```plaintext
cd ~/iac/docker-lab-ci
git switch main
git switch -c gitops16-vault-ids
cat > .github/scripts/vault-pass-client.sh <<'EOF'
（スクリプトの内容。上のファイルと同じ）
EOF
chmod +x .github/scripts/vault-pass-client.sh
bash -n .github/scripts/vault-pass-client.sh; echo "syntax_exit_code=$?"
git show 1c2ec24:ansible/inventories/dev/group_vars/target_nodes.yml > /tmp/gitops16-dev-new.yml
export ANSIBLE_VAULT_PASSWORD_GITOPS14=$(cat ~/.config/ansible-vault/gitops14-vault-pass)
export ANSIBLE_VAULT_PASSWORD_GITOPS16=$(cat ~/.config/ansible-vault/gitops16-vault-pass)
cd ansible
for f in inventories/dev/group_vars/target_nodes.yml /tmp/gitops16-dev-new.yml; do
  echo "== $f"
  sed -n '5p' "$f"
  ansible localhost -i localhost, -c local -m ansible.builtin.debug -a "msg={{ vault_ansible_user_password | length }}" -e @"$f" --vault-id gitops14@../.github/scripts/vault-pass-client.sh --vault-id gitops16@../.github/scripts/vault-pass-client.sh 2>&1 | grep -E '"msg"|ERROR'
done
cd ..
unset ANSIBLE_VAULT_PASSWORD_GITOPS14 ANSIBLE_VAULT_PASSWORD_GITOPS16
rm /tmp/gitops16-dev-new.yml
```

**▼ 実行結果**

```plaintext
（途中省略：ブランチの切り替えと、スクリプトの表示）
syntax_exit_code=0
== inventories/dev/group_vars/target_nodes.yml
          $ANSIBLE_VAULT;1.1;AES256
    "msg": "32"
== /tmp/gitops16-dev-new.yml
          $ANSIBLE_VAULT;1.2;AES256;gitops16
    "msg": "32"
```

古い暗号文も新しい暗号文も、同じ2つのVault IDの指定で復号できました。2つのワークフローで、Vaultパスワードを渡す環境変数と、`ansible-playbook`の指定を書き換えます。

**実行コマンド**

```plaintext
W=".github/workflows/gitops-pipeline.yml .github/workflows/gitops-apply.yml"
sed -i 's|^\( *\)ANSIBLE_VAULT_PASSWORD: ${{ secrets.ANSIBLE_VAULT_PASSWORD }}$|\1ANSIBLE_VAULT_PASSWORD_GITOPS14: ${{ secrets.ANSIBLE_VAULT_PASSWORD }}\n\1ANSIBLE_VAULT_PASSWORD_GITOPS16: ${{ secrets.ANSIBLE_VAULT_PASSWORD_GITOPS16 }}|' $W
sed -i 's|--vault-password-file ../.github/scripts/vault-pass.sh|--vault-id gitops14@../.github/scripts/vault-pass-client.sh --vault-id gitops16@../.github/scripts/vault-pass-client.sh|' $W
git --no-pager diff
git add .github/scripts/vault-pass-client.sh $W
git commit -m "GitOps第16回: Vault IDで新旧2つのVaultパスワード（gitops14、gitops16）を渡す"
git push -u origin gitops16-vault-ids
```

**▼ 実行結果**（`git diff`の部分を抜粋）

```diff
--- a/.github/workflows/gitops-apply.yml
+++ b/.github/workflows/gitops-apply.yml
@@ -231,9 +231,10 @@ jobs:
         working-directory: ansible
         env:
           PG_CONN_STR: ${{ secrets.PG_CONN_STR }}
-          ANSIBLE_VAULT_PASSWORD: ${{ secrets.ANSIBLE_VAULT_PASSWORD }}
+          ANSIBLE_VAULT_PASSWORD_GITOPS14: ${{ secrets.ANSIBLE_VAULT_PASSWORD }}
+          ANSIBLE_VAULT_PASSWORD_GITOPS16: ${{ secrets.ANSIBLE_VAULT_PASSWORD_GITOPS16 }}
           GITOPS_KEY_DIR: ${{ runner.temp }}/keys
-        run: ansible-playbook -i "inventories/$TARGET_ENV" site.yml --diff --vault-password-file ../.github/scripts/vault-pass.sh
+        run: ansible-playbook -i "inventories/$TARGET_ENV" site.yml --diff --vault-id gitops14@../.github/scripts/vault-pass-client.sh --vault-id gitops16@../.github/scripts/vault-pass-client.sh
（途中省略：gitops-pipeline.ymlも同じ2か所）
```

このプルリクエスト（PR#77）の確認の実行（「GitOps Pipeline」の実行#139）と、マージの実行（実行#140、マージコミット`80676ea`）では、どちらも`changes`ジョブが`.github/`の下だけの変更と判定し、ほかのジョブはすべてスキップされました。

**▼ 実行結果**（「GitOps Pipeline」の実行#140、`changes`ジョブから抜粋）

```plaintext
last applied (dev): 29aa5b3046c93a6e3cf82379ec6d3399a48a2ac6
last applied (stg): 29aa5b3046c93a6e3cf82379ec6d3399a48a2ac6
last applied (prod): 29aa5b3046c93a6e3cf82379ec6d3399a48a2ac6
.github/scripts/vault-pass-client.sh
.github/workflows/gitops-apply.yml
.github/workflows/gitops-pipeline.yml
terraform=false
ansible=false
```

### ■ 結果

Vaultパスワードの渡し方を変えるワークフローの変更は、確認のジョブを1つも通らずにmainに入り、承認待ちも作られませんでした。**[第9回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-09/)** で整理したとおり、ワークフローの変更はガードレールの対象外で、mainに入った時点で、次の実行から効きます。移行期間を作る変更は、承認ゲートを通さずに効いたことになります。

### ■ 検証内容：入れ替えのプルリクエストを、新しいワークフローで確かめ直す

PR#76のブランチに、新しいmainをマージで取り込んでプッシュし、新しいワークフローで確認を動かし直します。

**実行コマンド**

```plaintext
git switch gitops16-rotate-values
git merge --no-edit main
git push
```

**▼ 実行結果**

```plaintext
Merge made by the 'ort' strategy.
（途中省略）
   1c2ec24..6951835  gitops16-rotate-values -> gitops16-rotate-values
```

この確認の実行（「GitOps Pipeline」の実行#141）でも、`ansible-check`は、devの同じタスクで、同じ`censored`の失敗になりました。

**▼ 実行結果**（「GitOps Pipeline」の実行#141、`ansible-check`ジョブから抜粋）

```plaintext
  ansible-playbook -i "inventories/$e" site.yml --check --diff --vault-id gitops14@../.github/scripts/vault-pass-client.sh --vault-id gitops16@../.github/scripts/vault-pass-client.sh
（途中省略）
env:
  PG_CONN_STR: ***
  ANSIBLE_VAULT_PASSWORD_GITOPS14: ***
  ANSIBLE_VAULT_PASSWORD_GITOPS16: ***
（途中省略）
TASK [common_setup : ユーザーansibleのパスワードを設定] ************************
fatal: [dev-node1]: FAILED! => {"censored": "the output has been hidden due to the fact that 'no_log: true' was specified for this result"}
```

### 理由の見えない失敗を、ハッシュ値で切り分ける

ワークフローは2つのVault IDを渡すようになり、手元では同じ指定で復号できていました。手元と違うのは、ジョブに渡るSecretの値です。そこで、**[セクション3](#3-github-secretsは読み出せない)** と同じ方法で、`ANSIBLE_VAULT_PASSWORD_GITOPS16`を手元の控えとハッシュ値で照合しました。作業用のブランチに置いたワークフロー「Secret Hash Check 2」で、長さとハッシュ値に加えて、改行コード（CR）と空白の数を出します。

**▼ 実行結果**（手元の控え）

```plaintext
length=48
sha256=5abf24777cfa0f9c
```

**▼ 実行結果**（「Secret Hash Check 2」の実行#1、`secret-hash`ジョブから抜粋）

```plaintext
length=46
cr=0 sp=0
sha256=6a1a9f223bbd53e3
```

Secretの値は46文字で、手元の控えより2文字足りませんでした。画面に貼り付けたときに、2文字が欠けていたことになります。Secretの値を登録し直し、同じジョブをやり直すと、長さ48、ハッシュ値`5abf24777cfa0f9c`で一致しました。

**▼ 実行結果**（「Secret Hash Check 2」の実行#1をやり直したもの、`secret-hash`ジョブから抜粋）

```plaintext
length=48
cr=0 sp=0
sha256=5abf24777cfa0f9c
```

そのうえで、実行#141の失敗したジョブをやり直すと、`ansible-check`は成功し、5台すべてで、パスワードのタスクが`changed`と予測されました。

**▼ 実行結果**（「GitOps Pipeline」の実行#141をやり直したもの、`ansible-check`ジョブから抜粋）

```plaintext
== dev
（途中省略）
TASK [common_setup : ユーザーansibleのパスワードを設定] ************************
changed: [dev-node1]
（途中省略）
dev-node1                  : ok=6    changed=1    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0   
（途中省略：stg、prodも同じく changed=1、failed=0）
target-node1               : ok=6    changed=1    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0   
target-node2               : ok=6    changed=1    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0   
target-node3               : ok=6    changed=1    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0   
```

確認の後、作業用のブランチは削除しました。

### ■ 結果

実行#138と実行#141の失敗は、表示がまったく同じでした。原因は、前者が「ワークフローが新しいVaultパスワードを渡していない」、後者が「渡しているVaultパスワードの値が欠けていた」で、別のものです。`no_log`で理由が伏せられた失敗は、ログを見ても切り分けられません。手元の控えとのハッシュ値の照合が、入れ替えの途中で、Secretsの値が正しいかを確かめる手段になりました。

### ■ 検証内容：昇格の順に適用し、値が届いたことを確かめる

PR#76をマージすると（マージコミット`e2ef84a`、「GitOps Pipeline」の実行#142）、3環境の承認待ちが作られました。

**▼ 実行結果**（「GitOps Pipeline」の実行#142、`record-pending`ジョブから抜粋）

```plaintext
== dev
（途中省略）
commit=e2ef84ab5fd0d2dd24d1862e8802e6ce66c221b5
terraform=false
ansible=true
（途中省略：stg、prodも同じ）
```

適用の前に、値が届いたかを確かめる手段を用意します。**[第11回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-11/)** で確かめたとおり、パイプラインの記録は、インフラがその状態になったことまでは示しません。そこで、コンテナの`/etc/shadow`のハッシュ値と、新しい値・古い値から同じソルトで作ったハッシュ値とが一致するかだけを、`true`か`false`で表示する、照合用のPlaybookを手元に作りました。古い値は、`29aa5b3`の暗号文から取り出します。このPlaybookはコミットしません。

* **ファイル名：`/tmp/gitops16-verify.yml`**

```yaml
---
- name: ansibleのパスワードを、値を表示せずに照合する
  hosts: target_nodes
  gather_facts: false
  vars:
    gitops16_salt: "{{ (inventory_hostname | hash('sha256'))[:16] }}"
  tasks:
    - name: shadowを読む
      become: true
      no_log: true
      ansible.builtin.getent:
        database: shadow
        key: ansible
    - name: 照合の結果だけを表示する
      ansible.builtin.debug:
        msg: "new={{ getent_shadow['ansible'][0] == (vault_ansible_user_password | string | password_hash('sha512', gitops16_salt)) }} old={{ getent_shadow['ansible'][0] == (gitops16_old_password | string | password_hash('sha512', gitops16_salt)) }}"
```

**実行コマンド**

```plaintext
cd ~/iac/docker-lab-ci
git switch main
git pull
for e in dev stg prod; do git show 29aa5b3:ansible/inventories/$e/group_vars/target_nodes.yml | sed -n '/^vault_ansible_user_password: !vault |$/,$p' | sed 's/^vault_ansible_user_password:/gitops16_old_password:/' > /tmp/gitops16-old-$e.yml; done
cd ansible
set -a; . ~/.config/tfstate-backend/backend.env; set +a
for e in dev stg prod; do
  echo "== $e"
  ansible-playbook -i inventories/$e /tmp/gitops16-verify.yml -e @/tmp/gitops16-old-$e.yml --vault-id gitops14@$HOME/.config/ansible-vault/gitops14-vault-pass --vault-id gitops16@$HOME/.config/ansible-vault/gitops16-vault-pass 2>/dev/null | grep -E '"msg"|: ok='
done
cd ..
```

**▼ 実行結果**（適用の前）

```plaintext
== dev
    "msg": "new=False old=True"
dev-node1                  : ok=2    changed=0    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
== stg
    "msg": "new=False old=True"
stg-node1                  : ok=2    changed=0    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0
== prod
    "msg": "new=False old=True"
    "msg": "new=False old=True"
    "msg": "new=False old=True"
（途中省略：target-node1〜3の PLAY RECAP）
```

devに適用し（「GitOps Apply」の実行#80）、同じ照合を行いました。

**▼ 実行結果**（「GitOps Apply」の実行#80、`ansible-apply`ジョブから抜粋）

```plaintext
TASK [common_setup : ユーザーansibleのパスワードを設定] ************************
changed: [dev-node1]
（途中省略）
dev-node1                  : ok=6    changed=1    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0   
```

**▼ 実行結果**（devに適用した後の照合）

```plaintext
== dev
    "msg": "new=True old=False"
== stg
    "msg": "new=False old=True"
== prod
    "msg": "new=False old=True"
    "msg": "new=False old=True"
    "msg": "new=False old=True"
（途中省略：PLAY RECAP）
```

続けて、stg（「GitOps Apply」の実行#81）、prod（実行#82）の順に適用しました。どちらも、入口の確認で、前の環境に`e2ef84a`を適用済みであることが確かめられ、パスワードのタスクが`changed`になりました。

**▼ 実行結果**（3環境に適用した後の照合と、`gitops.applied`）

```plaintext
== dev
    "msg": "new=True old=False"
== stg
    "msg": "new=True old=False"
== prod
    "msg": "new=True old=False"
    "msg": "new=True old=False"
    "msg": "new=True old=False"
（途中省略：PLAY RECAP）
 id | env  |                commit_sha
----+------+------------------------------------------
 49 | prod | e2ef84ab5fd0d2dd24d1862e8802e6ce66c221b5
 48 | stg  | e2ef84ab5fd0d2dd24d1862e8802e6ce66c221b5
 47 | dev  | e2ef84ab5fd0d2dd24d1862e8802e6ce66c221b5
(3 rows)
```

### ■ 結果

新しい値は、devに適用した後はdevにだけ届き、stgとprodは古い値のままでした。入れ替えも、ほかの変更と同じく、昇格の順にしか届きません。3環境に適用した後は、5台すべてで新しい値と一致し、古い値とは一致しなくなりました。**[セクション4](#4-vaultパスワードを変えても過去の暗号文は守れない)** で整理したとおり、履歴の暗号文から古い値が読めても、その値は、もうどのコンテナのパスワードでもありません。

### ■ 検証内容：古いVault IDを残したまま、入れ替えをrevertする

ここで、入れ替えのマージ（`e2ef84a`）をrevertするプルリクエストを作ります。古いVault ID（`gitops14`）が、まだワークフローに残っている状態です。

**実行コマンド**

```plaintext
git switch -c gitops16-revert-values-1
git revert -m 1 --no-edit e2ef84a
for e in dev stg prod; do echo "== $e"; sed -n '4,5p' ansible/inventories/$e/group_vars/target_nodes.yml; done
git push -u origin gitops16-revert-values-1
```

**▼ 実行結果**

```plaintext
[gitops16-revert-values-1 198f901] Revert "Merge pull request #76 from juehara-crypto/gitops16-rotate-values"
（途中省略）
== dev
vault_ansible_user_password: !vault |
          $ANSIBLE_VAULT;1.1;AES256
（途中省略：stg、prodも同じ）
```

このプルリクエスト（PR#78）の確認の実行（「GitOps Pipeline」の実行#143）は、すべて成功しました。

**▼ 実行結果**（「GitOps Pipeline」の実行#143、`ansible-check`ジョブから抜粋）

```plaintext
TASK [common_setup : ユーザーansibleのパスワードを設定] ************************
changed: [dev-node1]
（途中省略）
dev-node1                  : ok=6    changed=1    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0   
（途中省略：stg、prodも同じく changed=1、failed=0）
```

PR#78は、マージせずに閉じました。

### ■ 検証内容：古いVault IDを外してから、もう一度revertする

3環境の`gitops.applied`に`e2ef84a`が記録されたことを確かめたので、ワークフローから`gitops14`を外し、使わなくなった`vault-pass.sh`も削除します。

**実行コマンド**

```plaintext
git switch main
git switch -c gitops16-drop-gitops14
W=".github/workflows/gitops-pipeline.yml .github/workflows/gitops-apply.yml"
sed -i '/ANSIBLE_VAULT_PASSWORD_GITOPS14: /d' $W
sed -i 's| --vault-id gitops14@../.github/scripts/vault-pass-client.sh||' $W
git rm -q .github/scripts/vault-pass.sh
grep -n -E 'vault|VAULT' $W
git add $W
git commit -m "GitOps第16回: 古いVaultパスワード（gitops14）をワークフローから外す"
git push -u origin gitops16-drop-gitops14
```

**▼ 実行結果**（`grep`以降を抜粋）

```plaintext
.github/workflows/gitops-pipeline.yml:189:          ANSIBLE_VAULT_PASSWORD_GITOPS16: ${{ secrets.ANSIBLE_VAULT_PASSWORD_GITOPS16 }}
.github/workflows/gitops-pipeline.yml:194:            ansible-playbook -i "inventories/$e" site.yml --check --diff --vault-id gitops16@../.github/scripts/vault-pass-client.sh
.github/workflows/gitops-apply.yml:234:          ANSIBLE_VAULT_PASSWORD_GITOPS16: ${{ secrets.ANSIBLE_VAULT_PASSWORD_GITOPS16 }}
.github/workflows/gitops-apply.yml:236:        run: ansible-playbook -i "inventories/$TARGET_ENV" site.yml --diff --vault-id gitops16@../.github/scripts/vault-pass-client.sh
[gitops16-drop-gitops14 01048ff] GitOps第16回: 古いVaultパスワード（gitops14）をワークフローから外す
 3 files changed, 2 insertions(+), 12 deletions(-)
 delete mode 100755 .github/scripts/vault-pass.sh
```

このプルリクエスト（PR#79）も、確認の実行（「GitOps Pipeline」の実行#144）とマージの実行（実行#145、マージコミット`b960dd8`）で、`changes`ジョブだけが動きました。マージの後、GitHubの画面で、古いSecretの`ANSIBLE_VAULT_PASSWORD`を削除しました。

その状態で、PR#78と同じく`e2ef84a`をrevertするプルリクエスト（PR#80、revertのコミット`7588cec`）を作りました。確認の実行（「GitOps Pipeline」の実行#146）では、`ansible-lint`と`molecule`は成功し、`ansible-check`が失敗しました。

**▼ 実行結果**（「GitOps Pipeline」の実行#146、`ansible-check`ジョブから抜粋）

```plaintext
  ansible-playbook -i "inventories/$e" site.yml --check --diff --vault-id gitops16@../.github/scripts/vault-pass-client.sh
（途中省略）
TASK [common_setup : ユーザーansibleのパスワードを設定] ************************
fatal: [dev-node1]: FAILED! => {"censored": "the output has been hidden due to the fact that 'no_log: true' was specified for this result"}

PLAY RECAP *********************************************************************
dev-node1                  : ok=4    changed=0    unreachable=0    failed=1    skipped=0    rescued=0    ignored=0   
```

PR#80も、マージせずに閉じました。最後に、作業用のブランチと照合用のファイルを削除し、手元の古いVaultパスワード（`gitops14-vault-pass`）も削除しました。

### ■ 結果

同じrevertの確認が、古いVault IDが残っている間は通り、外した後は止まりました。

|revertの時点|ワークフローのVault ID|`ansible-check`|
|---|---|---|
|PR#78（実行#143）|`gitops14`と`gitops16`|成功（5台で`changed`）|
|PR#80（実行#146）|`gitops16`だけ|devで`censored`の失敗|

古いVault IDが残っている間は、漏れた古い値に戻すrevertが、確認をすべて通りました。マージして適用すれば、漏れた値が、すべての環境に戻ります。古いVault IDを外した後に止まったのは、revertを防ぐ仕組みがあったからではなく、古い暗号文を開く鍵がなくなったからです。この違いは、**[セクション9](#9-入れ替えのコミットをrevertしてはいけない)** で整理します。

### 入れ替えの順序

ここまでの手順を、順序として並べます。

1. 新しいVaultパスワードを、新しい名前でSecretsに足す（古いものは残す）
2. ワークフローを、Vault IDで新旧2つを渡す形にする
3. 漏れた値を新しい値にし、新しいVaultパスワードで暗号化して、プルリクエストに通す
4. dev→stg→prodの順に適用し、値が届いたことを、値を表示せずに確かめる
5. 3環境の`gitops.applied`に記録されてから、古いVault IDをワークフローから外し、古いSecretと手元の控えを削除する

5の条件は、**[第11回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-11/)** のセクション6で、消すタスクを全環境に当てる前に外すと残りものが残ると確かめたのと、同じ構造です。古いVault IDを外すのは、新しい値が、すべての環境に届いたことを記録で確かめてからにします。

次のセクションでは、Gitの履歴から過去の暗号文や平文を消す手順が、どこまで効くのかを確かめます。

---

[↑ 目次に戻る](#-目次)

---

## 7. 履歴からの削除は最後の手段

**[第13回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part3/ansible-gitops-part3-13/)** のセクション3で、Gitの履歴から秘密を消す手順は、この回に譲りました。ここでは、消したはずのコミットがどこに残っているかを確かめ、手元から実際に消したうえで、その削除がどこまで効くのかを確かめます。

### 履歴から消すとは、すべての複製から消すこと

Gitのリポジトリは、複製されて使われます。この検証環境では、手元のリポジトリのほかに、self-hostedランナーの作業ディレクトリと、GitHubにも、同じ履歴があります。チームで使えば、メンバーそれぞれのクローンも加わります。

ブランチを削除しても、コミットそのものは、すぐには消えません。**[第13回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part3/ansible-gitops-part3-13/)** のセクション3と、この回の **[セクション4](#4-vaultパスワードを変えても過去の暗号文は守れない)** でも、ブランチを削除した後に、コミットが手元に残っていることを確かめています。履歴から秘密を消すには、そのコミットを、すべての複製から消す必要があります。

### ■ 検証内容：削除したブランチのコミットが、どこに残っているか

これまでの回で作り、ブランチを削除したコミットのうち、次の4つが、手元・ランナー・GitHubのどこに残っているかを確かめます。

|コミット|作った回|プッシュ|
|---|---|---|
|`eacb72f`、`9df7394`|第13回|していない|
|`f1efdac`|第14回（暗号化し忘れた平文のダミー値を含む）|した|
|`42052e2`|この回のセクション4|していない|

手元とランナーの作業ディレクトリでは、`git cat-file -t`で、コミットが残っているかを確かめます。あわせて、そのコミットを含むブランチの数も出します。

**実行コマンド**

```plaintext
cd ~/iac/docker-lab-ci
R=/home/control/actions-runner/_work/ansible-terraform-ci-lab/ansible-terraform-ci-lab
for c in eacb72f 9df7394 f1efdac 42052e2; do
  echo "== $c"
  echo -n "local:  "; git cat-file -t $c 2>&1
  echo -n "runner: "; git -C "$R" cat-file -t $c 2>&1
  echo -n "local branches containing: "; git branch -a --contains $c 2>/dev/null | wc -l
done
git --no-pager show --stat --format='%h %s' f1efdac
git -C "$R" log --oneline -1
```

**▼ 実行結果**

```plaintext
== eacb72f
local:  commit
runner: fatal: Not a valid object name eacb72f
local branches containing: 0
== 9df7394
local:  commit
runner: fatal: Not a valid object name 9df7394
local branches containing: 0
== f1efdac
local:  commit
runner: commit
local branches containing: 0
== 42052e2
local:  commit
runner: fatal: Not a valid object name 42052e2
local branches containing: 0
f1efdac GitOps第14回: 暗号化し忘れを含むファイルを追加（フックを外してコミット）

 .github/scripts/vault-check.sh  | 24 ++++++++++++++++++++++++
 ansible/gitops14/vault_vars.yml | 10 ++++++++++
 2 files changed, 34 insertions(+)
9aef5d3 (grafted, HEAD, pull/80/merge) Merge 7588cecb6fd5174ca8fb45a4f8308976cdd37abe into b960dd85a1be6ecd956bad4644863d52e0165739
```

GitHubでは、ブラウザで`https://github.com/juehara-crypto/ansible-terraform-ci-lab/commit/<コミット>`を開いて確かめました。`eacb72f`と`42052e2`は404でした。`f1efdac`は、コミットの画面が表示され、`ansible/gitops14/vault_vars.yml`の中の平文のダミー値（`vault_db_password`）も、そのまま見えました。

### ■ 検証内容：手元から、たどれないコミットを消す

手元のリポジトリから、どのブランチからもたどれないコミットを消します。`git reflog expire`で、操作の記録（reflog）に残った参照を消し、`git gc --prune=now`で、どこからも参照されなくなったオブジェクトを、すぐに削除します。ランナーの作業ディレクトリには、何もしません。

**実行コマンド**

```plaintext
git count-objects -v | grep -E '^(count|in-pack|size-pack):'
git reflog expire --expire-unreachable=now --all
git gc --prune=now --quiet
git count-objects -v | grep -E '^(count|in-pack|size-pack):'
for c in eacb72f 9df7394 f1efdac 42052e2; do
  echo "== $c"
  echo -n "local:  "; git cat-file -t $c 2>&1
  echo -n "runner: "; git -C "$R" cat-file -t $c 2>&1
done
git log --oneline -1
git status --short; echo "git_status_exit_code=$?"
```

**▼ 実行結果**

```plaintext
count: 863
in-pack: 0
size-pack: 0
count: 0
in-pack: 672
size-pack: 162
== eacb72f
local:  fatal: Not a valid object name eacb72f
runner: fatal: Not a valid object name eacb72f
== 9df7394
local:  fatal: Not a valid object name 9df7394
runner: fatal: Not a valid object name 9df7394
== f1efdac
local:  fatal: Not a valid object name f1efdac
runner: commit
== 42052e2
local:  fatal: Not a valid object name 42052e2
runner: fatal: Not a valid object name 42052e2
b960dd8 (HEAD -> main, origin/main) Merge pull request #79 from juehara-crypto/gitops16-drop-gitops14
git_status_exit_code=0
```

手元から消した後に、もう一度、GitHubで`f1efdac`を開きました。コミットの画面が表示され、上部に次の文が出ました。平文のダミー値を含む中身も、そのまま見えました。

```plaintext
This commit does not belong to any branch on this repository, and may belong to a fork outside of the repository.
```

### ■ 結果

|コミット|手元（削除前）|手元（削除後）|ランナー|GitHub|
|---|---|---|---|---|
|`eacb72f`|残っている|消えた|ない|404|
|`9df7394`|残っている|消えた|ない|（確認していない）|
|`f1efdac`|残っている|消えた|残っている|表示される|
|`42052e2`|残っている|消えた|ない|404|

プッシュしていないコミットは、手元にしかありませんでした。手元から消せば、それで消えます。

プッシュした`f1efdac`は、ブランチを削除しても、手元から消しても、ランナーの作業ディレクトリとGitHubに残りました。GitHubは、どのブランチにも属していないことを示しながらも、コミットの画面を表示し続けています。リポジトリを読める人は、コミットのハッシュ値さえ分かれば、その中身を見られる状態です。手元の`git`の操作で消せたのは、手元の複製だけでした。

### 消すより先に、値を無効にする

プッシュした秘密を、履歴から確実に消すには、自分の手が届かない複製まで含めて、消す必要があります。ランナーの作業ディレクトリは自分で消せますが、メンバーのクローンや、GitHubの側に残ったものは、それぞれの持ち主やGitHubに頼むことになります。すでに誰かが手元に取得していれば、その複製を消す手段はありません。

さらに、mainの履歴を書き換える場合は、GitOpsの仕組みそのものに影響します。履歴を書き換えると、書き換えた以降のコミットは、すべて別のハッシュ値になります。**[第11回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-11/)** から使っている`gitops.applied`には、各環境に最後に適用したコミットのハッシュ値を記録していて、`changes`ジョブは、そのコミットを基準に変更を判定しています。書き換えた後のmainからは、記録したコミットを、たどれなくなります。履歴の書き換えは、強制プッシュを伴うため、mainを守るガードレールとも衝突します。

そのため、漏洩への対応の順序は、次のようになります。

1. 漏れた値を入れ替え、古い値をどこでも通用しなくする（**[セクション6](#6-入れ替えをパイプラインに通す)**）
2. 必要なら、履歴から消す。ただし、消せるのは自分の手が届く複製だけで、消したからといって、漏れた値が安全になるわけではない

**[セクション4](#4-vaultパスワードを変えても過去の暗号文は守れない)** の結論と同じく、履歴に残る秘密への対応の中心は、消すことではなく、その値を使えなくすることです。履歴からの削除は、値を入れ替えた後に、さらに見える範囲を狭めたいときの、最後の手段です。

次のセクションでは、接続用の鍵を入れ替えます。値をパイプラインに通して入れ替えるのは同じですが、鍵では、新旧の両方を受け付ける移行期間を、コードの側で作ります。

---

[↑ 目次に戻る](#-目次)

---

## 8. 鍵の入れ替えと再生成

接続用の鍵を入れ替えます。値をパイプラインに通して入れ替えるのは、**[セクション6](#6-入れ替えをパイプラインに通す)** と同じです。違うのは、新旧の両方を受け付ける移行期間を、Vault IDではなく、Gitの中のコードで作る点です。

### 鍵の置き場所も2つあり、片方は昇格しない

**[第15回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part3/ansible-gitops-part3-15/)** の構成では、接続用の鍵は、次の2か所に分かれています。

* 秘密鍵は、GitHubのSecrets（`CONNECT_PRIVATE_KEY_DEV`・`_STG`・`_PROD`）に置き、ジョブの中で一時ディレクトリに書き出す
* 公開鍵は、Gitの`terraform/envs/<環境>/connect_key.pub`に置き、Terraformがコンテナの`authorized_keys`に書く

Vaultパスワードと同じく、Secretsは上書きした瞬間にすべてのジョブに効き、公開鍵はプルリクエストと承認ゲートを通って、dev→stg→prodの順に届きます。秘密鍵だけを先に変えると、まだ古い公開鍵しか持たない環境に接続できなくなります。公開鍵だけを先に変えると、新しい公開鍵が届いた環境に、古い秘密鍵で接続できなくなります。

`authorized_keys`は、モジュール`lab_env`で、次のように組み立てています。

* **ファイル名：`terraform/modules/lab_env/main.tf`（抜粋）**

```hcl
  upload {
    file    = "/home/ansible/.ssh/authorized_keys"
    content = "${var.operator_public_key}\n${var.connect_public_key}"
  }
```

`connect_public_key`は、`connect_key.pub`の中身です。`authorized_keys`は1行に1つの公開鍵を書く形式なので、`connect_key.pub`に古い公開鍵と新しい公開鍵の2行を書けば、どちらの秘密鍵でも入れる`authorized_keys`になります。これが、鍵の移行期間です。

この検証では、次の順に進めます。

|段階|内容|
|---|---|
|1|3環境の新しい鍵を、手元に作る|
|2|`connect_key.pub`を「古い公開鍵＋新しい公開鍵」にし、dev→stg→prodの順に適用する|
|3|Secretsの秘密鍵を、新しい鍵に上書きする|
|4|`connect_key.pub`を「新しい公開鍵」だけにし、dev→stg→prodの順に適用する|

### ■ 検証内容：新旧の両方を受け付ける公開鍵を、3環境に適用する

3環境の新しい鍵を、手元に作ります。古い鍵と見分けられるよう、コメントに`gitops16`を付けます。

**実行コマンド**

```plaintext
for e in dev stg prod; do
  ssh-keygen -q -t ed25519 -N '' -C "gitops-$e-connect-gitops16" -f ~/.config/gitops-keys/$e/id_ed25519.new
done
for e in dev stg prod; do echo "== $e"; ssh-keygen -lf ~/.config/gitops-keys/$e/id_ed25519; ssh-keygen -lf ~/.config/gitops-keys/$e/id_ed25519.new; done
```

**▼ 実行結果**

```plaintext
== dev
256 SHA256:oJnNtKhFcDjYtAywj85U1wPzdEw5/IEiIgq1VW+cj0U gitops-dev-connect (ED25519)
256 SHA256:PjkpB+gSERvn61ZOeHgKJH92AaXwVavCED9+YrhwSIA gitops-dev-connect-gitops16 (ED25519)
== stg
256 SHA256:pmIEcnhshITW1oPBZCDJ73AMGhXnPszK6VXpXw/OVjw gitops-stg-connect (ED25519)
256 SHA256:R+UCm1oOaRpPrDnA7TCBr2GOcCB8LJX59YsXSPU2zfQ gitops-stg-connect-gitops16 (ED25519)
== prod
256 SHA256:+h2eH4Wjmm+1j0sccCbo5yBpLAz6Wudg0+W67B8x1wU gitops-prod-connect (ED25519)
256 SHA256:i4KD+eNOt/ZQ7t1YQK5uPNpbah7IZqj+U/ABVAzSy6k gitops-prod-connect-gitops16 (ED25519)
```

3環境の`connect_key.pub`の末尾に、新しい公開鍵を1行足して、プルリクエスト（PR#81）を作りました。

**実行コマンド**

```plaintext
cd ~/iac/docker-lab-ci
git switch -c gitops16-connect-key-both
for e in dev stg prod; do
  tail -c 1 terraform/envs/$e/connect_key.pub | od -c | head -1
  cat ~/.config/gitops-keys/$e/id_ed25519.new.pub >> terraform/envs/$e/connect_key.pub
done
for e in dev stg prod; do echo "== $e"; wc -l < terraform/envs/$e/connect_key.pub; ssh-keygen -lf terraform/envs/$e/connect_key.pub; done
git add terraform/envs/dev/connect_key.pub terraform/envs/stg/connect_key.pub terraform/envs/prod/connect_key.pub
git commit -m "GitOps第16回: 接続用の公開鍵に新しい鍵を足し、新旧の両方を受け付ける"
git push -u origin gitops16-connect-key-both
```

**▼ 実行結果**

```plaintext
0000000  \n
0000000  \n
0000000  \n
== dev
2
256 SHA256:oJnNtKhFcDjYtAywj85U1wPzdEw5/IEiIgq1VW+cj0U gitops-dev-connect (ED25519)
256 SHA256:PjkpB+gSERvn61ZOeHgKJH92AaXwVavCED9+YrhwSIA gitops-dev-connect-gitops16 (ED25519)
（途中省略：stg、prodも同じく2行）
[gitops16-connect-key-both df622e7] GitOps第16回: 接続用の公開鍵に新しい鍵を足し、新旧の両方を受け付ける
 3 files changed, 3 insertions(+)
（以降省略）
```

PR#81の確認の実行（「GitOps Pipeline」の実行#147）では、`terraform-plan`が、5台すべてのコンテナを作り直す計画を出しました。

**▼ 実行結果**（「GitOps Pipeline」の実行#147、`terraform-plan`ジョブのdevの部分から抜粋）

```plaintext
      - upload { # forces replacement
          - content        = <<-EOT
                ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIJ9ZflEAp+DdFuvvm/+Y7HhfCtg0n51gm5xN4IfNH9aM control@ubuntu-controller
                
                ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAz+NtNOYPFp/GbhcGHjmlZD6Y0rUpCGGbHXQfvZX/Dl gitops-dev-connect
            EOT -> null
（途中省略）
      + upload { # forces replacement
          + content        = <<-EOT
                ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIJ9ZflEAp+DdFuvvm/+Y7HhfCtg0n51gm5xN4IfNH9aM control@ubuntu-controller
                
                ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAz+NtNOYPFp/GbhcGHjmlZD6Y0rUpCGGbHXQfvZX/Dl gitops-dev-connect
                ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIMxd/bdcHYaPhD4+ztdu0r1XynngBuJEfseYtZ/zPKvH gitops-dev-connect-gitops16
            EOT
（途中省略）
Plan: 1 to add, 0 to change, 1 to destroy.
```

**[第15回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part3/ansible-gitops-part3-15/)** のセクション7と同じく、`upload`の中身が変わると、コンテナは作り直しになります。PR#81をマージし（マージコミット`aa5ddb8`）、「削除と作り直しを許可する」を付けて、dev（「GitOps Apply」の実行#83）、stg（実行#84）、prod（実行#85）の順に適用しました。

**▼ 実行結果**（「GitOps Apply」の実行#83から抜粋）

```plaintext
（verifyジョブ）
BLOCK module.lab_env.docker_container.targets["dev-node1"] actions=delete,create reason=replace_because_cannot_update
policy: blocked (1)
##[warning]delete or replace is allowed in dev
（terraform-applyジョブ）
module.lab_env.docker_container.targets["dev-node1"]: Destroying... [id=ccbed5d7aaa2...]
module.lab_env.docker_container.targets["dev-node1"]: Creation complete after 2s [id=4ed3b7187e1e...]
Apply complete! Resources: 1 added, 0 changed, 1 destroyed.
（ansible-applyジョブ）
dev-node1                  : ok=6    changed=3    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0   
```

作り直したコンテナに、ジョブは古い秘密鍵で接続し、設定ファイルとパスワードを入れ直しました（`changed=3`）。3環境に適用した後、手元から、5台それぞれに古い鍵と新しい鍵で接続しました。

**実行コマンド**

```plaintext
for t in dev:2242 stg:2251 prod:2231 prod:2222 prod:2223; do
  e=${t%%:*}; p=${t##*:}
  for k in id_ed25519 id_ed25519.new; do
    r=$(ssh -i ~/.config/gitops-keys/$e/$k -p $p -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR ansible@127.0.0.1 'hostname' 2>&1); echo "$e port=$p key=$k rc=$? $r"
  done
done
```

**▼ 実行結果**

```plaintext
dev port=2242 key=id_ed25519 rc=0 4ed3b7187e1e
dev port=2242 key=id_ed25519.new rc=0 4ed3b7187e1e
stg port=2251 key=id_ed25519 rc=0 07059fa5b165
stg port=2251 key=id_ed25519.new rc=0 07059fa5b165
prod port=2231 key=id_ed25519 rc=0 428f99c73b04
prod port=2231 key=id_ed25519.new rc=0 428f99c73b04
prod port=2222 key=id_ed25519 rc=0 d6373dd27213
prod port=2222 key=id_ed25519.new rc=0 d6373dd27213
prod port=2223 key=id_ed25519 rc=0 383e68e8a209
prod port=2223 key=id_ed25519.new rc=0 383e68e8a209
```

### ■ 結果

5台すべてで、古い鍵と新しい鍵の、どちらでも接続できました。移行期間が、3環境に揃ったことになります。

### ■ 検証内容：Secretsの秘密鍵を切り替え、古い公開鍵を外す

両方を受け付ける状態が揃ってから、Secretsの`CONNECT_PRIVATE_KEY_DEV`・`_STG`・`_PROD`を、GitHubの画面で、新しい秘密鍵に上書きしました。**[セクション6](#6-入れ替えをパイプラインに通す)** のように、貼り付けで値が崩れていないかを、作業用のブランチに置いたワークフロー「Secret Hash Check 3」で、手元の新しい鍵とハッシュ値で照合します。

**▼ 実行結果**（手元の新しい鍵）

```plaintext
DEV sha256=7fc8a0eb420c3fee
STG sha256=245ebcdf9c7f95ab
PROD sha256=26b5e6ffe45e146c
```

**▼ 実行結果**（「Secret Hash Check 3」の実行#1、`secret-hash`ジョブから抜粋）

```plaintext
DEV cr=0 sha256=7fc8a0eb420c3fee
STG cr=0 sha256=245ebcdf9c7f95ab
PROD cr=0 sha256=26b5e6ffe45e146c
```

3つとも一致しました。手元の鍵も、新しい鍵を`id_ed25519`に、古い鍵を`id_ed25519.old`に置き換えたうえで、3環境の`connect_key.pub`を新しい公開鍵の1行だけにして、プルリクエスト（PR#82）を作りました。

**実行コマンド**

```plaintext
for e in dev stg prod; do
  d=~/.config/gitops-keys/$e
  mv $d/id_ed25519 $d/id_ed25519.old; mv $d/id_ed25519.pub $d/id_ed25519.old.pub
  mv $d/id_ed25519.new $d/id_ed25519; mv $d/id_ed25519.new.pub $d/id_ed25519.pub
done
git switch -c gitops16-connect-key-new
for e in dev stg prod; do cp ~/.config/gitops-keys/$e/id_ed25519.pub terraform/envs/$e/connect_key.pub; done
for e in dev stg prod; do echo "== $e"; wc -l < terraform/envs/$e/connect_key.pub; ssh-keygen -lf terraform/envs/$e/connect_key.pub; done
git add terraform/envs/dev/connect_key.pub terraform/envs/stg/connect_key.pub terraform/envs/prod/connect_key.pub
git commit -m "GitOps第16回: 接続用の公開鍵から古い鍵を外し、新しい鍵だけを受け付ける"
git push -u origin gitops16-connect-key-new
```

**▼ 実行結果**

```plaintext
== dev
1
256 SHA256:PjkpB+gSERvn61ZOeHgKJH92AaXwVavCED9+YrhwSIA gitops-dev-connect-gitops16 (ED25519)
（途中省略：stg、prodも同じく1行）
[gitops16-connect-key-new b2802b1] GitOps第16回: 接続用の公開鍵から古い鍵を外し、新しい鍵だけを受け付ける
 3 files changed, 3 deletions(-)
（以降省略）
```

PR#82の確認の実行（「GitOps Pipeline」の実行#149）では、`terraform-plan`が、`authorized_keys`から古い鍵の行を外す作り直しを予測しました。`ansible-check`は、上書きしたSecretsの秘密鍵で、5台すべてに接続できました。

**▼ 実行結果**（「GitOps Pipeline」の実行#149、`ansible-check`ジョブから抜粋）

```plaintext
-rw------- 1 control control 419 Oct 20 11:25 id_ed25519
（途中省略：stg、prodも同じく419バイト）
dev-node1                  : ok=6    changed=0    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0   
stg-node1                  : ok=6    changed=0    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0   
target-node1               : ok=6    changed=0    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0   
target-node2               : ok=6    changed=0    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0   
target-node3               : ok=6    changed=0    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0   
```

PR#82をマージし（マージコミット`00cc80b`）、dev（「GitOps Apply」の実行#87）、stg（実行#88）、prod（実行#89）の順に適用しました。どの環境も、コンテナを作り直したうえで、新しい秘密鍵で接続して`changed=3`になりました。3環境に適用した後、手元から、5台それぞれに古い鍵と新しい鍵で接続しました。

**実行コマンド**

```plaintext
for t in dev:2242 stg:2251 prod:2231 prod:2222 prod:2223; do
  e=${t%%:*}; p=${t##*:}
  for k in id_ed25519.old id_ed25519; do
    r=$(ssh -i ~/.config/gitops-keys/$e/$k -p $p -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR ansible@127.0.0.1 'hostname' 2>&1); echo "$e port=$p key=$k rc=$? $r"
  done
done
set -a; . ~/.config/tfstate-backend/backend.env; set +a
psql "$PG_CONN_STR" -X -c 'SELECT id, env, commit_sha FROM gitops.applied ORDER BY id DESC LIMIT 3;'
```

**▼ 実行結果**

```plaintext
dev port=2242 key=id_ed25519.old rc=255 ansible@127.0.0.1: Permission denied (publickey,password).
dev port=2242 key=id_ed25519 rc=0 f4104de77bf8
stg port=2251 key=id_ed25519.old rc=255 ansible@127.0.0.1: Permission denied (publickey,password).
stg port=2251 key=id_ed25519 rc=0 6f2dad5917fc
prod port=2231 key=id_ed25519.old rc=255 ansible@127.0.0.1: Permission denied (publickey,password).
prod port=2231 key=id_ed25519 rc=0 ade38668fb28
prod port=2222 key=id_ed25519.old rc=255 ansible@127.0.0.1: Permission denied (publickey,password).
prod port=2222 key=id_ed25519 rc=0 d2dc713dc2d4
prod port=2223 key=id_ed25519.old rc=255 ansible@127.0.0.1: Permission denied (publickey,password).
prod port=2223 key=id_ed25519 rc=0 5a401b899a4d
 id | env  |                commit_sha
----+------+------------------------------------------
 55 | prod | 00cc80b198e0c51b3a10a387b3f9ac0d3a9b0644
 54 | stg  | 00cc80b198e0c51b3a10a387b3f9ac0d3a9b0644
 53 | dev  | 00cc80b198e0c51b3a10a387b3f9ac0d3a9b0644
(3 rows)
```

### ■ 結果

5台すべてで、古い鍵は`Permission denied`で拒否され、新しい鍵だけで接続できました。秘密鍵の上書きは、両方を受け付ける状態が揃った後に行ったため、入れ替えの途中で、確認や適用が接続できずに止まることはありませんでした。

|段階|`authorized_keys`|Secretsの秘密鍵|古い鍵で接続|新しい鍵で接続|
|---|---|---|---|---|
|入れ替え前|古い鍵|古い鍵|できる|―|
|PR#81の適用後|古い鍵＋新しい鍵|古い鍵|できる|できる|
|Secretsの上書き後|古い鍵＋新しい鍵|新しい鍵|できる|できる|
|PR#82の適用後|新しい鍵|新しい鍵|できない|できる|

### ■ 検証内容：古い鍵を外したマージを、revertする

ここで、古い鍵を外したマージ（`00cc80b`）をrevertするプルリクエスト（PR#83）を作りました。

**実行コマンド**

```plaintext
git switch main
git switch -c gitops16-revert-connect-key
git revert -m 1 --no-edit 00cc80b
for e in dev stg prod; do echo "== $e"; wc -l < terraform/envs/$e/connect_key.pub; ssh-keygen -lf terraform/envs/$e/connect_key.pub; done
git push -u origin gitops16-revert-connect-key
```

**▼ 実行結果**

```plaintext
[gitops16-revert-connect-key f1d2780] Revert "Merge pull request #82 from juehara-crypto/gitops16-connect-key-new"
 Date: Tue Oct 20 11:52:43 2026 +0000
 3 files changed, 3 insertions(+)
== dev
2
256 SHA256:oJnNtKhFcDjYtAywj85U1wPzdEw5/IEiIgq1VW+cj0U gitops-dev-connect (ED25519)
256 SHA256:PjkpB+gSERvn61ZOeHgKJH92AaXwVavCED9+YrhwSIA gitops-dev-connect-gitops16 (ED25519)
（途中省略：stg、prodも同じく2行）
```

PR#83の確認の実行（「GitOps Pipeline」の実行#151）は、すべて成功しました。`terraform-plan`は、古い鍵の行を`authorized_keys`に戻す作り直しを予測しました。

**▼ 実行結果**（「GitOps Pipeline」の実行#151、`terraform-plan`ジョブのdevの部分から抜粋）

```plaintext
      + upload { # forces replacement
          + content        = <<-EOT
                ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIJ9ZflEAp+DdFuvvm/+Y7HhfCtg0n51gm5xN4IfNH9aM control@ubuntu-controller
                
                ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAz+NtNOYPFp/GbhcGHjmlZD6Y0rUpCGGbHXQfvZX/Dl gitops-dev-connect
                ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIMxd/bdcHYaPhD4+ztdu0r1XynngBuJEfseYtZ/zPKvH gitops-dev-connect-gitops16
            EOT
（途中省略）
Plan: 1 to add, 0 to change, 1 to destroy.
（途中省略：stgは1 to add, 1 to destroy、prodは3 to add, 3 to destroy）
```

**▼ 実行結果**（「GitOps Pipeline」の実行#151、`ansible-check`ジョブから抜粋）

```plaintext
dev-node1                  : ok=6    changed=0    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0   
stg-node1                  : ok=6    changed=0    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0   
target-node1               : ok=6    changed=0    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0   
target-node2               : ok=6    changed=0    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0   
target-node3               : ok=6    changed=0    unreachable=0    failed=0    skipped=0    rescued=0    ignored=0   
```

PR#83は、マージせずに閉じました。最後に、作業用のブランチと、手元の古い鍵（`id_ed25519.old`）を削除しました。

### ■ 結果

鍵のrevertは、確認の実行を、何にも止められずに通りました。マージして「削除と作り直しを許可する」を付けて適用すれば、拒否されるようになったはずの古い鍵が、3環境の`authorized_keys`に戻ります。

**[セクション6](#6-入れ替えをパイプラインに通す)** では、古いVault IDを外した後のrevertは、古い暗号文を開けずに止まりました。鍵のrevertは、`authorized_keys`に新しい鍵も残るため、パイプラインの接続は切れず、何も失敗しません。止まるかどうかは、revertで戻るものを、今のパイプラインが使えるかどうかで決まっていて、戻してよいかどうかとは関係がありません。

|revertするもの|戻る値|確認の実行|
|---|---|---|
|`ansible`のパスワード（古いVault IDを外した後）|古い暗号文|止まる（復号できない）|
|接続用の公開鍵|古い公開鍵（新しい公開鍵と並ぶ）|通る|

### 入れ替えの順序

鍵の入れ替えの順序を、まとめます。

1. 新しい鍵を作る
2. 公開鍵を「古い＋新しい」にし、dev→stg→prodの順に適用する（移行期間）
3. 3環境に揃ったことを確かめてから、Secretsの秘密鍵を新しい鍵に上書きし、手元の控えとハッシュ値で照合する
4. 公開鍵を「新しい」だけにし、dev→stg→prodの順に適用する
5. 古い鍵で入れないことを確かめてから、手元の古い鍵を削除する

Vaultパスワードの入れ替えでは、移行期間をワークフローのVault IDで作り、その変更はガードレールを通らずにmainに入りました。鍵の入れ替えでは、移行期間を`connect_key.pub`というコードで作るため、移行期間そのものが、プルリクエスト、`terraform-plan`、承認ゲート、昇格の順序を通ります。そのぶん、コンテナの作り直しが2回起きます。

次のセクションでは、セクション6とこのセクションのrevertの結果を並べ、入れ替えのコミットをrevertしてはいけない理由を整理します。

---

[↑ 目次に戻る](#-目次)

---

## 9. 入れ替えのコミットをrevertしてはいけない

**[セクション6](#6-入れ替えをパイプラインに通す)** と **[セクション8](#8-鍵の入れ替えと再生成)** では、入れ替えを終えた後に、入れ替えのマージをrevertするプルリクエストを作り、確認の実行で何が起きるかを確かめました。ここでは、その結果を並べて、入れ替えの後に問題が起きたときに、どう戻すべきかを整理します。

### GitOpsでは、戻すことはrevertすること

**[第11回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-11/)** では、GitOpsで変更を取り消すときは、mainの履歴を書き換えるのではなく、取り消すコミットをプルリクエストに通すことを確かめました。`git revert`は、その取り消すコミットを作る、いちばん手早い方法です。

通常の変更であれば、revertで1つ前の状態に戻すことに、問題はありません。ところが、入れ替えのコミットは違います。入れ替えのコミットの「1つ前の状態」とは、漏れた値を使っていた状態です。入れ替えのコミットをrevertすると、漏れた値が、もう一度コードに戻ります。

### 3つのrevertの結果

2つのセクションで作ったrevertのプルリクエストを、並べます。

|プルリクエスト|revertしたもの|そのときの状態|確認の実行|
|---|---|---|---|
|PR#78（「GitOps Pipeline」の実行#143）|`ansible`のパスワードの入れ替え|古いVault IDが残っている|すべて成功|
|PR#80（「GitOps Pipeline」の実行#146）|`ansible`のパスワードの入れ替え|古いVault IDを外した後|`ansible-check`が失敗|
|PR#83（「GitOps Pipeline」の実行#151）|接続用の鍵の入れ替え|古い鍵を外した後|すべて成功|

3つのうち、確認の実行で止まったのは、PR#80の1つだけでした。PR#78とPR#83は、マージして適用すれば、漏れた古い値と、拒否したはずの古い鍵を、3環境に戻せる状態でした。

### 止まったのは、偶然の防御

PR#80が止まったのは、パイプラインに、入れ替えのrevertを止める仕組みがあったからではありません。古いVault IDを外したため、revertで戻した古い暗号文を、パイプラインが開けなくなったからです。止まったのは、古い暗号文を開く鍵がなくなったという、入れ替えの手順の副作用です。

同じ入れ替えでも、古いVault IDを外す前（PR#78）は通りました。鍵の入れ替え（PR#83）は、`authorized_keys`に新しい鍵も残るため、古いVault IDを外したときのような副作用がなく、最後まで通りました。止まるかどうかは、revertで戻るものを、今のパイプラインが使えるかどうかで決まっていて、その値が漏れているかどうかとは関係がありません。

* パイプラインは、値が漏れたかどうかを知らない
* 確認の実行が見ているのは、復号できるか、接続できるか、計画に削除が含まれるかといった、動くかどうかだけ
* 漏れた値に戻すrevertも、動くのであれば、正しい変更として通る

PR#80の失敗も、表示は`censored`だけでした。**[セクション6](#6-入れ替えをパイプラインに通す)** で確かめたとおり、Secretsの値の誤りとも見分けがつきません。復号の失敗を、Secretsの誤りと思い込んで、古いVault IDをワークフローに足し直せば、PR#80も通ります。**[第12回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-12/)** で整理したとおり、止まったパイプラインを通すための操作は、それ自体がガードレールを壊します。偶然の防御は、それを偶然と知らない人の、善意の操作で、簡単に外れます。

### 入れ替えの後の問題は、前に進めて直す

入れ替えの後に問題が起きることは、あります。新しい値を設定したサービスが動かない、新しい鍵が一部のホストに届いていない、といった場合です。そのときに戻す先は、漏れた古い値ではなく、さらに新しい値です。

**[第11回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part2/ansible-gitops-part2-11/)** のセクション6では、消したものを戻すのではなく、消すと書いた変更を前に進めて、残りものを片付けました。入れ替えの後の問題も、同じ形で直します。

* 新しい値に問題があれば、もう一度、別の新しい値に入れ替える
* 新しい鍵が届いていない環境があれば、その環境に、新しい鍵を届ける変更を出す
* どちらも、セクション6とセクション8の順序で、プルリクエストと承認ゲートを通す

|問題|してはいけないこと|すること|
|---|---|---|
|新しい値で動かない|入れ替えのコミットをrevertする|さらに新しい値に入れ替える|
|復号できずに止まった|古いVault IDを足し直す|Secretsの値を、手元の控えとハッシュ値で照合する|
|新しい鍵で入れない環境がある|古い公開鍵を`connect_key.pub`に戻す|その環境に新しい公開鍵を届ける|

### revertを止めるのは、人の判断

入れ替えのコミットのrevertを、パイプラインで確実に止める仕組みは、この検証環境にはありません。漏れた値の一覧をどこかに持ち、それと一致する値がコードに戻ったら止める、という仕組みは考えられます。しかし、その一覧そのものが、漏れた値を集めた新しい秘密になります。

そのため、入れ替えのコミットには、revertしてはいけない変更であることを、人が読める形で残しておきます。たとえば、コミットメッセージやプルリクエストの説明に、漏洩への対応であることと、問題が起きたときは前に進めて直すことを書いておきます。revertのプルリクエストを見た人が、それが漏れた値に戻す変更であると気づけるようにするためです。

次のセクションでは、ここまでの考え方が、クラウドのシークレット管理サービスを使う場合にも、そのまま当てはまることを整理します。

---

[↑ 目次に戻る](#-目次)

---

## 10. クラウドでも復旧の考え方は同じ

ここまでの検証は、Ansible Vault、GitHubのSecrets、Gitで管理する公開鍵という、この検証環境の構成で行いました。クラウドのシークレット管理サービス（AWS Secrets Manager、Azure Key Vault、Google CloudのSecret Managerなど）を使う場合でも、復旧の考え方は変わりません。ここでは、この回で確かめたことを、クラウドの言葉に置き換えて整理します。

### 置き場所が変わっても、写しはなくならない

クラウドのシークレット管理サービスを使うと、秘密の値は、Gitの暗号文やGitHubのSecretsではなく、サービスの中に置きます。パイプラインやアプリケーションは、実行するときに、サービスから値を取り出して使います。

置き場所が1つにまとまるように見えますが、**[セクション3](#3-github-secretsは読み出せない)** と **[セクション7](#7-履歴からの削除は最後の手段)** で確かめたことは、そのまま当てはまります。

* 取り出した値は、ジョブの中、アプリケーションの設定、操作対象のホストに、写しとして残る
* 多くのサービスは、値を書き換えても、過去の値をバージョンとして残す。Gitの履歴に古い暗号文が残るのと同じく、過去のバージョンを読める権限があれば、古い値を取り出せる
* 値を取り出せる権限を持つものは、人だけではない。パイプラインのロールやサービスアカウントも、取り出せる側に含まれる

漏れた値を、どこからも消し去ることはできない、という点は、クラウドでも同じです。

### 入れ替えには、移行期間が要る

**[セクション6](#6-入れ替えをパイプラインに通す)** と **[セクション8](#8-鍵の入れ替えと再生成)** では、新旧の両方を受け付ける期間を作ってから、古いものを外しました。クラウドのシークレット管理サービスでも、入れ替えは同じ形で行います。

* 新しい値をバージョンとして追加し、使う側が新しい値に切り替わる間、古い値も有効にしておく
* すべての使う側が新しい値に切り替わったことを確かめてから、古いバージョンを無効にする

AWS Secrets Managerのローテーションが、新しい値に`AWSPENDING`、今の値に`AWSCURRENT`、1つ前の値に`AWSPREVIOUS`というラベルを付けて切り替えていくのは、この移行期間を、サービスの側で作る仕組みです。この回で、Vault IDを2つ並べたり、`connect_key.pub`に2行を書いたりしたのと、役割は同じです。

古いバージョンを無効にする条件も、変わりません。この回では、3環境の`gitops.applied`に記録されてから、古いVault IDを外しました。クラウドでも、すべての使う側が新しい値で動いていることを確かめるまで、古いバージョンは外せません。

### 戻すことが、漏れた値に戻すことになる

**[セクション9](#9-入れ替えのコミットをrevertしてはいけない)** で整理した危うさも、クラウドで同じように起きます。過去のバージョンを残すサービスでは、1つ前のバージョンに戻す操作が、用意されていることがあります。入れ替えの後に問題が起きたとき、その操作で1つ前に戻すと、漏れた値が、もう一度今の値になります。

クラウドの管理画面やAPIは、その値が漏れたものかどうかを知りません。確認の実行が、値が動くかどうかだけを見ていたのと同じく、サービスも、指定されたバージョンを今の値にするだけです。

|この回で確かめたこと|この検証環境|クラウドのシークレット管理サービス|
|---|---|---|
|値は読み出せないが、控えにもならない|GitHubのSecrets|取り出す権限を絞ると、使う側以外からは読めない。控えは別に持つ|
|過去の値が残る|Gitの履歴の暗号文|過去のバージョン|
|新旧の両方を受け付ける期間|Vault IDの併用、`connect_key.pub`の2行|新しいバージョンの追加と、古いバージョンの一時的な維持|
|古いものを外す条件|3環境の`gitops.applied`への記録|すべての使う側が、新しい値で動いていることの確認|
|戻すと、漏れた値に戻る|入れ替えのコミットのrevert|1つ前のバージョンに戻す操作|

### 復旧は、秘密を消すことではなく、通用しなくすること

この回で確かめたことを、1つにまとめると、次のようになります。

**漏れた秘密は消せない。復旧とは、漏れた値をどこでも通用しない値にすることであり、そのためには、新旧の両方を受け付ける期間を作り、すべての環境に新しい値が届いたことを記録で確かめてから、古い値を外す。**

置き場所が、Gitの暗号文、CIのシークレット、クラウドのシークレット管理サービスのどれであっても、この順序は変わりません。変わるのは、移行期間を作る手段と、届いたことを確かめる記録の置き場所だけです。

次のセクションでは、この回の内容をまとめます。

---

[↑ 目次に戻る](#-目次)

---

## 11. まとめ

この回で整理した内容を確認します。

* 漏洩は、第三者が秘密を知った状態で、知られた値は取り戻せないため、値を入れ替えて古い値を通用しなくする。破損・紛失は、本来読める人も読めなくなった状態で、控えと履歴から元に戻す。対応は逆になるが、誤ったVaultパスワードと壊れた暗号文は、どちらも同じ`Decryption failed`の表示になり、表示からは見分けられないことを実機で確認した。見分ける手がかりは、同じVaultパスワードでほかの値が復号できるかどうかである
* GitHubのSecretsは、編集の画面でも値が表示されず、控えにはならない。値を読み出さなくても、ジョブの中で出したハッシュ値を手元の控えと比べれば、同じ値かどうかを照合できることを実機で確認した。破損に備える控えは、GitHubの外に、少なくとも1つはランナーのホストとも別の場所に持つ
* Vaultパスワードを新しくして再暗号化しても、再暗号化する前のコミットの暗号文は、古いVaultパスワードで今も復号できることを実機で確認した。再暗号化は暗号文を作り直すだけで、漏れた値そのものは変えない。Vaultパスワードが漏れたときは、そのVaultパスワードで暗号化していた値そのものも入れ替える
* ファイル全体を暗号化したファイルは`ansible-vault rekey`の1回で切り替わるが、値ごとに暗号化したファイルは`rekey`の対象にならず、変数ごとに復号と暗号化を繰り返す手順が要ることを実機で確認した。値ごとの暗号化は、値を変えるときの手間が少ないかわりに、Vaultパスワードを入れ替えるときの手間が多くなる
* Vaultパスワードの置き場所は、すぐに全体へ効くSecretsと、昇格の順に届くGitの暗号文の2つで、同時には変えられない。Vault IDで新旧2つのVaultパスワードを渡す移行期間を作り、`ansible`のパスワードを新しい値に入れ替えて、dev→stg→prodの順に適用した。コンテナのパスワードのハッシュ値との照合で、新しい値が昇格の順に届き、3環境に適用した後は古い値とどこでも一致しなくなったことを、値を表示せずに確かめた。`no_log: true`のタスクの失敗は理由が伏せられ、Secretsの値の誤りも同じ表示になったため、ハッシュ値の照合で切り分けた
* 削除したブランチのコミットは、手元から`git gc`で消せたが、プッシュしたコミットは、ランナーの作業ディレクトリとGitHubに残り、GitHubではどのブランチにも属さないまま中身が表示され続けることを実機で確認した。履歴からの削除は自分の手が届く複製にしか効かず、mainの書き換えは`gitops.applied`の記録とも衝突する。対応の中心は値を使えなくすることで、履歴からの削除は最後の手段である
* 接続用の鍵は、`connect_key.pub`に古い公開鍵と新しい公開鍵の2行を書くことで、移行期間をコードの側で作れる。両方を受け付ける状態を3環境に揃えてからSecretsの秘密鍵を上書きし、古い公開鍵を外した後は、古い鍵では入れず、新しい鍵だけで入れることを確認した
* 入れ替えのコミットをrevertすると、漏れた値がコードに戻る。古いVault IDを外した後のパスワードのrevertは止まったが、古いVault IDが残っている間のrevertと、鍵のrevertは、確認の実行をすべて通った。止まるかどうかは、戻るものを今のパイプラインが使えるかで決まり、値が漏れているかどうかとは関係がない。入れ替えの後の問題は、さらに新しい値に入れ替えて、前に進めて直す
* クラウドのシークレット管理サービスでも、過去のバージョンが残る、移行期間が要る、1つ前のバージョンに戻すと漏れた値に戻る、という構造は同じである

---

[↑ 目次に戻る](#-目次)

---

## 12. 次回予告

本シリーズの **[第15回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part3/ansible-gitops-part3-15/)** では、どの秘密をAnsible Vaultで扱い、どの秘密をGitHubのSecretsで扱うかを、「その秘密が何と一緒に変わるか」というライフサイクルを基準に確定させ、Terraformが作っていた接続用の鍵と、Terraformを経由していたユーザーのパスワードを移して、tfstateに秘密が残らなくなることを実機で確かめました。第16回となる今回は、置き場所を決めた秘密が漏れたとき、失われたときの対応を扱いました。漏洩と破損を分け、GitHubのSecretsが読み出せず控えにならないこと、Vaultパスワードを変えても過去の暗号文は守れないこと、暗号化の単位によって再暗号化の手間が変わることを実機で確かめました。そのうえで、Vaultパスワードと`ansible`のパスワードの入れ替えをVault IDで、接続用の鍵の入れ替えを`connect_key.pub`の2行で、それぞれ新旧の両方を受け付ける移行期間を作ってパイプラインに通し、履歴からの削除がどこまで効くかと、入れ替えのコミットをrevertしてはいけない理由を整理しました。

今回で、第3部（第13回〜第16回）は終わりです。第3部では、「すべてをGitに置く」というGitOpsの考え方と、機密情報を置いてはいけないという制約の衝突から出発しました。**[第13回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part3/ansible-gitops-part3-13/)** で、Gitに置かなかった値も、tfstate、保存したplan、イメージの履歴、ジョブのログに残ることを確かめ、**[第14回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part3/ansible-gitops-part3-14/)** で、Ansible Vaultで暗号化した値がVaultパスワード1つの後ろに集まることを確かめました。**[第15回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part3/ansible-gitops-part3-15/)** では、置き場所を、その秘密が何と一緒に変わるかで決め、今回は、置いた秘密が漏れたときに、消すのではなく通用しなくすることで復旧しました。どの回でも、秘密は、暗号文になり、写しになり、履歴になり、形を変えて残り続けました。置き場所を決めるだけでなく、どこに残るかを知り、残ったものを通用しなくする手順まで持って、機密情報の設計になります。

次回からは、第4部（第17回〜第21回）として、ドリフトの検知と自動収束を扱います。第3部では、パイプラインを通した変更だけで、操作対象を入れ替えてきました。しかし、操作対象は、パイプラインの外からも変わります。第4部では、Gitに書いたあるべき状態と、操作対象の実際の状態の食い違いを、どう見つけ、どう戻すかを扱います。今回入れ替えたVaultパスワードと接続用の鍵は、第4部の検証でも、そのまま使います。

**[次回：第17回：GitOps環境でドリフトはなぜ起きるのか](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part4/ansible-gitops-part4-17/)**

---

📑 連載の移動　**[前の記事：【GitOps編】第15回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part3/ansible-gitops-part3-15/)　｜　[次の記事：【GitOps編】第17回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part4/ansible-gitops-part4-17/)**

---

> **🗺️ 初めての方、シリーズの全体像を知りたい方はこちら**
>
> シリーズ全体については、以下のまとめブログで整理しています。
>
> → **「Ansible×TerraformをGitOpsで回す」〜Terraformプロバイダーを問わない構成管理の自動化〜 第3部まとめブログ：機密情報は「どこに置くか」だけでなく「どこに残るか」で設計する** **※近日公開予定**

---

[↑ 目次に戻る](#-目次)

---

## 13. 連載一覧：「Ansible×TerraformをGitOpsで回す」

### 第3部：GitOpsパイプラインでの機密情報管理

|回数|テーマ、記事タイトル|概要|
|---|---|---|
|**[第13回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part3/ansible-gitops-part3-13/)**|なぜGitリポジトリに機密情報を置いてはいけないのか|「すべてをGitに置く」GitOpsと機密情報の衝突を出発点に、非公開リポジトリでも十分ではない理由をGitの履歴で確かめる。第2部で暫定のまま残した機密情報を2種類に分類して棚卸しし、tfstate・保存したplan・イメージの履歴・ジョブログというGit以外の漏洩経路を実機で示す。Ansible×Terraformシリーズ第18回との接続を示す。第3部の初回。|
|**[第14回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part3/ansible-gitops-part3-14/)**|Ansible VaultをGitOpsパイプラインで安全に扱う|暗号化した値がVaultパスワードに集まることを出発点に、Vaultパスワードの渡し方とself-hostedランナーに残る一時ファイル、暗号化の単位とプルリクエストの差分、`--check --diff`のログに出る復号した値を実機で確かめ、レビューで見せたいものと隠したいものの衝突を整理する。暗号化し忘れを止める場所と、環境ごとにVaultパスワードを分けたときの限界を示す。|
|**[第15回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part3/ansible-gitops-part3-15/)**|Ansible VaultとGitHub Secretsの役割分担|「その秘密が何と一緒に変わるか」というライフサイクルを基準に、「Gitの中はVault、Gitの外は鍵」の役割分担を確定させる。基準に合わない置き方の帰結を整理し、Terraformが作っていた接続用の鍵と、Terraformを経由していたユーザーのパスワードを移して、tfstateに秘密が残らなくなることを実機で確かめる。プルリクエストのジョブがEnvironmentの規則にどう照合されるかを確かめ、Secretsを環境ごとに分けても残る限界と、OIDCで長期間有効な鍵を預けない設計を示す。|
|**[第16回](https://juehara-crypto.github.io/blog/infra/ansible/ansible-gitops/ansible-gitops-part3/ansible-gitops-part3-16/)**|Vault情報が漏洩・破損した場合の復旧設計|漏洩と破損を分け、両者が同じ復号の失敗として現れることを確かめる。GitHub Secretsが読み出せず控えにならないこと、Vaultパスワードの変更では過去の暗号文を守れないこと、暗号化の単位で再暗号化の手間が変わることを示す。Vault IDと`connect_key.pub`の2行で新旧の両方を受け付ける移行期間を作り、パスワードと接続用の鍵の入れ替えをパイプラインに通す。履歴からの削除の限界と、入れ替えのコミットをrevertしてはいけない理由を第11回と接続する。第3部の最終回。|

---

[↑ 目次に戻る](#-目次)

---