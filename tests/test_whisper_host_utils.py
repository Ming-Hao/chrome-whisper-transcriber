import base64
import os
import tempfile
import unittest
import uuid
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

    def test_save_recording_bundle_writes_files(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            saved_paths = utils.save_recording_bundle(
                self.fake_audio_bytes,
                "hello world",
                output_dir=tmpdir,
                tab_title="My Tab / Name",
            )
            self.assertTrue(saved_paths["folder"].startswith(tmpdir))
            self.assertTrue(os.path.isdir(saved_paths["folder"]))
            self.assertTrue(os.path.exists(saved_paths["audio"]))
            self.assertTrue(os.path.exists(saved_paths["text"]))
            folder_basename = os.path.basename(saved_paths["folder"])
            self.assertTrue(folder_basename.startswith("My Tab _ Name-"))
            with open(saved_paths["audio"], "rb") as f:
                self.assertEqual(f.read(), self.fake_audio_bytes)
            with open(saved_paths["text"], "r", encoding="utf-8") as f:
                self.assertEqual(f.read(), "hello world")

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
                text, saved_paths = utils.transcribe_audio_chunk(
                    self.fake_audio_b64,
                    self.mock_model,
                    save_to_disk=True,
                    output_dir=tmpdir,
                    tab_title="Another:Title",
                )

            self.assertEqual(text, "hello world")
            self.assertIsInstance(saved_paths, dict)
            self.assertTrue(saved_paths["folder"].startswith(tmpdir))
            self.assertTrue(os.path.isdir(saved_paths["folder"]))
            self.assertTrue(os.path.exists(saved_paths["audio"]))
            self.assertTrue(os.path.exists(saved_paths["text"]))
            folder_basename = os.path.basename(saved_paths["folder"])
            self.assertTrue(folder_basename.startswith("Another_Title-"))
            with open(saved_paths["audio"], "rb") as f:
                self.assertEqual(f.read(), self.fake_audio_bytes)
            with open(saved_paths["text"], "r", encoding="utf-8") as f:
                self.assertEqual(f.read(), "hello world")

    def test_open_recordings_folder_mac(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            with mock.patch("whisper_host_utils.platform.system", return_value="Darwin"), \
                 mock.patch("whisper_host_utils.subprocess.Popen") as popen_mock:
                folder = utils.open_recordings_folder(output_dir=tmpdir)

        popen_mock.assert_called_once_with(["open", tmpdir])
        self.assertEqual(folder, tmpdir)

    def test_open_recordings_folder_linux(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            with mock.patch("whisper_host_utils.platform.system", return_value="Linux"), \
                 mock.patch("whisper_host_utils.subprocess.Popen") as popen_mock:
                folder = utils.open_recordings_folder(output_dir=tmpdir)

        popen_mock.assert_called_once_with(["xdg-open", tmpdir])
        self.assertEqual(folder, tmpdir)

    def test_open_specific_folder_mac(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            subdir = os.path.join(tmpdir, "saved")
            os.mkdir(subdir)
            with mock.patch("whisper_host_utils.platform.system", return_value="Darwin"), \
                 mock.patch("whisper_host_utils.subprocess.Popen") as popen_mock:
                folder = utils.open_specific_folder(subdir)

        popen_mock.assert_called_once_with(["open", subdir])
        self.assertEqual(folder, subdir)

    def test_open_specific_folder_missing(self):
        missing_path = os.path.join(tempfile.gettempdir(), "missing-" + uuid.uuid4().hex)
        if os.path.exists(missing_path):
            self.fail("Generated missing path unexpectedly exists.")
        with self.assertRaises(FileNotFoundError):
            utils.open_specific_folder(missing_path)


if __name__ == "__main__":
    unittest.main()
