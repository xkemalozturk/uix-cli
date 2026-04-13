# UIX

Monorepo veya tek paket projelerde registry component kurulumu için CLI.

## Kurulum

### Global Kurulum

```bash
bun install
bun link
```

Artık `uix` komutu terminalde her yerden kullanılabilir:

```bash
uix -v
uix shadcn
```

### Proje Bazlı Kurulum

Projeye devDependency olarak ekle:

```bash
bun add -d uix-cli@github:xkemalozturk/uix-cli
```

`bunx` üzerinden kullanılabilir:

```bash
bunx uix -v
bunx uix shadcn
```

İsteğe bağlı olarak `package.json`'a script olarak eklenebilir:

```json
{
  "scripts": {
    "uix": "uix"
  }
}
```

Böylece şu şekilde çalıştırılabilir:

```bash
bun run uix -- shadcn
bun run uix -- -v
bun run uix -- list
```

## Hızlı Başlangıç

```bash
uix <url|alias>
```

Örnek:

```bash
uix shadcn
uix diceui
```

## Komutlar

### Registry Üzerinden Kurulum

```bash
# normal kurulum
uix <url|alias>

# kurmadan önce hangi componentlerin kurulacağını yazdır
uix <url|alias> --dry

# mevcut dosya kontrolünü kapat
uix <url|alias> --no-diff

# hedef klasörü belirt (monorepo için önerilir)
uix <url|alias> --cwd=packages/ui
```

### Shadcn Native Mod

```bash
# shadcn add interactive (component seçimi)
uix init shadcn --cwd=packages/ui

# tüm componentleri kur
uix init shadcn --all --cwd=packages/ui
```

Not: `init shadcn` modunda `--cwd` verilmezse ve `packages/ui` varsa otomatik orası kullanılır.

### Init

```bash
# yeni ui paketi oluştur + registry kurulumu
uix init --name=@myorg/ui --dir=packages/ui <url|alias>

# yeni ui paketi oluştur, ardından shadcn native tüm kurulum
uix init --name=@workspace/ui --dir=packages/ui
uix init shadcn --all --cwd=packages/ui
```

### Diğer

```bash
# versiyon bilgisini göster
uix -v
uix --version

# yardım mesajını göster
uix -h
uix --help

# registry listesini göster
uix list

# bir önceki kurulumda başarısız olanları tekrar dene
uix retry --cwd=packages/ui

# kurulu component güncellemelerini kontrol et
uix outdated --cwd=packages/ui

# sadece güncellemesi olan componentleri overwrite ederek güncelle
uix update --cwd=packages/ui
```
