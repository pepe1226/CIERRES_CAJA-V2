import importlib.util
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

spec = importlib.util.spec_from_file_location("cashbox_sync", Path(__file__).parents[1] / "scripts" / "sync_perseo_cashboxes.py")
sync = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sync)


class CashboxSyncTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.cache = Path(self.directory.name) / "fingerprints.json"
        self.manifests = [["1", "2026-10", "1", "100", "1001", "1002", "2026-10-05"], ["19", "2026-10", "1", "-50", "1901", "1902", "2026-10-06"]]
        self.rows = [["1", "1", "2026-10-05", "2026-10-05 10:00:00", "100", "IN", "Venta", "RC1"], ["2", "19", "2026-10-06", "2026-10-06 10:00:00", "-50", "EG", "Pago", "CE2"]]
        self.movement_queries = []
        for name, value in [("DB_EXE", Mock(is_file=lambda: True)), ("CACHE_PATH", self.cache)]:
            p = patch.object(sync, name, value); p.start(); self.addCleanup(p.stop)
        p = patch.object(sync, "credential", return_value=("etiquetas_ro", "test-only")); p.start(); self.addCleanup(p.stop)
        p = patch.object(sync, "query", side_effect=self.query); p.start(); self.addCleanup(p.stop)

    def query(self, sql, user, password):
        if "FROM cajas" in sql:
            return [["1", "Esperado"], ["19", "Caja activa nueva"]]
        if "BIT_XOR" in sql:
            return self.manifests
        self.movement_queries.append(sql)
        return self.rows if "cajasid IN" in sql else [self.rows[0]]

    def seed_cache(self):
        summary, _ = sync.collect()
        self.cache.write_text(json.dumps(sync._cache_to_save), encoding="utf-8")
        self.movement_queries.clear()
        return summary

    def test_includes_new_active_box_and_negative_balance(self):
        summary, history = sync.collect()
        self.assertEqual([box["id"] for box in summary["boxes"]], [1, 19])
        self.assertEqual(summary["boxes"][1]["balanceCents"], -50)
        self.assertEqual(len(history), 2)

    def test_unchanged_months_do_not_download_movements_again(self):
        first = self.seed_cache()
        second, history = sync.collect(use_cache=True)
        self.assertEqual(second["boxes"], first["boxes"])
        self.assertEqual(history, {})
        self.assertEqual(self.movement_queries, [])

    def test_editing_a_description_refreshes_only_its_month(self):
        first = self.seed_cache()
        self.manifests[0][4] = "changed"
        self.rows[0][6] = "Concepto corregido"
        second, history = sync.collect(use_cache=True)
        self.assertEqual(list(history), [(1, "2026-10")])
        self.assertNotEqual(second["boxes"][0]["months"][0]["hash"], first["boxes"][0]["months"][0]["hash"])
        self.assertEqual(second["boxes"][1], first["boxes"][1])

    def test_concurrent_perseo_changes_prevent_publishing_partial_balances(self):
        self.rows[0][4] = "101"
        with self.assertRaisesRegex(RuntimeError, "cambió durante"):
            sync.collect()


if __name__ == "__main__":
    unittest.main()
