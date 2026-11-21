import base64
import json
import os
import struct
import tempfile
import unittest

from Cryptodome.Cipher import AES

from app import ncm


def pad(data):
    size = 16 - len(data) % 16
    return data + bytes([size]) * size


def aes_encrypt(data, key):
    return AES.new(key, AES.MODE_ECB).encrypt(pad(data))


class NcmDecoderTests(unittest.TestCase):
    def test_decrypts_audio_and_metadata(self):
        audio = b"ID3" + bytes(range(256)) * 8
        audio_key = b"unit-test-audio-key"
        metadata = {
            "musicName": "Test Song",
            "artist": [["Test Artist", 1]],
            "album": "Test Album",
            "format": "mp3",
        }
        encrypted_key = aes_encrypt(b"x" * 17 + audio_key, ncm.CORE_KEY)
        meta = b"x" * 22 + base64.b64encode(
            aes_encrypt(b"music:" + json.dumps(metadata).encode("utf-8"), ncm.META_KEY)
        )
        encrypted_audio = ncm._xor_audio(audio, ncm._make_key_box(audio_key))
        fixture = (
            ncm.MAGIC + b"\0\0"
            + struct.pack("<I", len(encrypted_key))
            + bytes(value ^ 0x64 for value in encrypted_key)
            + struct.pack("<I", len(meta))
            + bytes(value ^ 0x63 for value in meta)
            + b"\0" * 9
            + struct.pack("<I", 0)
            + encrypted_audio
        )
        with tempfile.TemporaryDirectory() as directory:
            source = os.path.join(directory, "song.ncm")
            target = os.path.join(directory, "song.mp3")
            with open(source, "wb") as out:
                out.write(fixture)
            info = ncm.inspect(source)
            result = ncm.decrypt(source, target)
            with open(target, "rb") as out:
                self.assertEqual(out.read(), audio)
        self.assertEqual(info["display_name"], "Test Song - Test Artist")
        self.assertEqual(info["extension"], "mp3")
        self.assertEqual(result["tags"], {
            "title": "Test Song", "artist": "Test Artist", "album": "Test Album",
        })


if __name__ == "__main__":
    unittest.main()
