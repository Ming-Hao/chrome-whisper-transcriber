import base64
import os
import tempfile
import unittest
from unittest import mock

import numpy as np

import whisper_host_utils as utils


class WhisperHostUtilsTest(unittest.TestCase):
    def setUp(self):
        self.fake_audio_bytes = b"fake-webm-bytes"
        self.fake_audio_b64 = base64.b64encode(self.fake_audio_bytes).decode("ascii")
        self.fake_wav_array = np.array([0.1, 0.2], dtype=np.float32)
        self.mock_model = mock.Mock()
        self.mock_model.transcribe.return_value = {"text": " hello world "}

    def test_save_audio_bytes_writes_file(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            saved_path = utils.save_audio_bytes(self.fake_audio_bytes, output_dir=tmpdir)
            self.assertTrue(os.path.exists(saved_path))
            with open(saved_path, "rb") as f:
                self.assertEqual(f.read(), self.fake_audio_bytes)
            self.assertTrue(saved_path.endswith(".webm"))

    def test_transcribe_audio_chunk_without_saving(self):
        with mock.patch.object(utils, "convert_webm_to_wav_array", return_value=self.fake_wav_array) as convert_mock:
            text, saved_path = utils.transcribe_audio_chunk(self.fake_audio_b64, self.mock_model, save_to_disk=False)

        convert_mock.assert_called_once()
        self.mock_model.transcribe.assert_called_once_with(self.fake_wav_array)
        self.assertEqual(text, "hello world")
        self.assertIsNone(saved_path)

    def test_transcribe_audio_chunk_with_saving(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            with mock.patch.object(utils, "convert_webm_to_wav_array", return_value=self.fake_wav_array):
                text, saved_path = utils.transcribe_audio_chunk(
                    self.fake_audio_b64,
                    self.mock_model,
                    save_to_disk=True,
                    output_dir=tmpdir,
                )

            self.assertEqual(text, "hello world")
            self.assertTrue(saved_path.startswith(tmpdir))
            self.assertTrue(os.path.exists(saved_path))
            with open(saved_path, "rb") as f:
                self.assertEqual(f.read(), self.fake_audio_bytes)


if __name__ == "__main__":
    unittest.main()
