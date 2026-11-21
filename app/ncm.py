"""Local decoder for Netease Cloud Music .ncm files.

The decoder only operates on files selected by the user.  It does not make
network requests or use account cookies.
"""
import base64
import json
import os
import struct


CORE_KEY = b"hzHRAmso5kInbaxW"
META_KEY = b"#14ljk_!\\]&0U<'("
MAGIC = b"CTENFDAM"
MAX_SECTION_SIZE = 64 * 1024 * 1024
CHUNK_SIZE = 1024 * 1024  # A multiple of 256, preserving the stream phase.


class NcmError(ValueError):
    """A selected file is not a supported or complete NCM file."""


class NcmCancelled(Exception):
    """The caller requested cancellation while the audio stream was copied."""


def _aes_decrypt(data, key):
    try:
        from Cryptodome.Cipher import AES
    except ImportError as exc:
        raise NcmError("缺少 NCM 解密组件，请重新安装或更新 VideoDL") from exc
    if not data or len(data) % 16:
        raise NcmError("NCM 加密区长度无效")
    return AES.new(key, AES.MODE_ECB).decrypt(data)


def _read_exact(src, size, label):
    if size < 0 or size > MAX_SECTION_SIZE:
        raise NcmError(f"{label}长度异常")
    data = src.read(size)
    if len(data) != size:
        raise NcmError(f"NCM 文件不完整：{label}读取失败")
    return data


def _read_u32(src, label):
    return struct.unpack("<I", _read_exact(src, 4, label))[0]


def _unpad(data, label):
    if not data:
        raise NcmError(f"{label}为空")
    padding = data[-1]
    if padding < 1 or padding > 16 or data[-padding:] != bytes([padding]) * padding:
        raise NcmError(f"{label}填充无效")
    return data[:-padding]


def _make_key_box(key):
    if not key:
        raise NcmError("NCM 音频密钥为空")
    box = bytearray(range(256))
    j = 0
    for i in range(256):
        j = (box[i] + j + key[i % len(key)]) & 0xFF
        box[i], box[j] = box[j], box[i]
    return box


def _xor_audio(data, key_box):
    out = bytearray(data)
    for i in range(len(out)):
        index = (i + 1) & 0xFF
        out[i] ^= key_box[
            (key_box[index] + key_box[(key_box[index] + index) & 0xFF]) & 0xFF
        ]
    return out


def _decode_metadata(data):
    if len(data) <= 22:
        raise NcmError("NCM 元数据区无效")
    encoded = bytes(value ^ 0x63 for value in data)[22:]
    try:
        encrypted = base64.b64decode(encoded, validate=True)
    except Exception as exc:
        raise NcmError("NCM 元数据编码无效") from exc
    raw = _unpad(_aes_decrypt(encrypted, META_KEY), "NCM 元数据")
    try:
        text = raw.decode("utf-8")
        if text.startswith("music:"):
            text = text[6:]
        metadata = json.loads(text)
    except Exception as exc:
        raise NcmError("NCM 元数据无法读取") from exc
    if not isinstance(metadata, dict):
        raise NcmError("NCM 元数据格式无效")
    return metadata


def _parse_header(source_path):
    with open(source_path, "rb") as src:
        if _read_exact(src, 8, "文件头") != MAGIC:
            raise NcmError("不是有效的网易云 .ncm 文件")
        _read_exact(src, 2, "文件头保留区")

        key_size = _read_u32(src, "密钥长度")
        encrypted_key = bytes(value ^ 0x64 for value in _read_exact(src, key_size, "密钥区"))
        audio_key = _unpad(_aes_decrypt(encrypted_key, CORE_KEY), "NCM 音频密钥")[17:]
        key_box = _make_key_box(audio_key)

        meta_size = _read_u32(src, "元数据长度")
        metadata = _decode_metadata(_read_exact(src, meta_size, "元数据区"))
        _read_exact(src, 4, "CRC 区")
        _read_exact(src, 5, "封面标志区")
        cover_size = _read_u32(src, "封面长度")
        cover = _read_exact(src, cover_size, "封面区")
        audio_offset = src.tell()
    return metadata, cover, key_box, audio_offset


def _artists(metadata):
    artists = metadata.get("artist") or metadata.get("artists") or []
    names = []
    if isinstance(artists, str):
        return artists
    if isinstance(artists, list):
        for artist in artists:
            if isinstance(artist, str):
                names.append(artist)
            elif isinstance(artist, (list, tuple)) and artist:
                names.append(str(artist[0]))
            elif isinstance(artist, dict) and artist.get("name"):
                names.append(str(artist["name"]))
    return ", ".join(name for name in names if name)


def output_extension(metadata):
    extension = str(metadata.get("format") or "mp3").lower().strip(".")
    if extension not in {"mp3", "flac", "m4a", "aac", "ogg", "wav"}:
        return "mp3"
    return extension


def display_name(metadata, fallback):
    title = str(metadata.get("musicName") or metadata.get("name") or fallback).strip()
    artist = _artists(metadata)
    return f"{title} - {artist}" if artist else title


def tags(metadata):
    return {
        "title": str(metadata.get("musicName") or metadata.get("name") or "").strip(),
        "artist": _artists(metadata),
        "album": str(metadata.get("album") or metadata.get("albumName") or "").strip(),
    }


def inspect(source_path):
    """Read display metadata without writing an output file."""
    metadata, _cover, _key_box, _audio_offset = _parse_header(source_path)
    return {
        "metadata": metadata,
        "extension": output_extension(metadata),
        "display_name": display_name(metadata, os.path.splitext(os.path.basename(source_path))[0]),
    }


def decrypt(source_path, output_path, progress=None, cancelled=None):
    """Decrypt an NCM file into *output_path* and return its tags and cover."""
    metadata, cover, key_box, audio_offset = _parse_header(source_path)
    total = max(1, os.path.getsize(source_path) - audio_offset)
    done = 0
    with open(source_path, "rb") as src, open(output_path, "wb") as dst:
        src.seek(audio_offset)
        while True:
            if cancelled and cancelled():
                raise NcmCancelled()
            chunk = src.read(CHUNK_SIZE)
            if not chunk:
                break
            dst.write(_xor_audio(chunk, key_box))
            done += len(chunk)
            if progress:
                progress(min(1.0, done / total))
    return {"metadata": metadata, "cover": cover, "extension": output_extension(metadata), "tags": tags(metadata)}
