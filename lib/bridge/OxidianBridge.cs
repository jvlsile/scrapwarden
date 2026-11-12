// Oxidian Bridge
// Complemento que instala Oxidian en Oxide/Carbon. Expone el inventario de los jugadores
// por RCON y envía a la consola los eventos que el panel analiza (antihack, reportes F7, impactos y muertes PvP).
// Las líneas de evento empiezan por "RPANEL|" seguidas de JSON; el panel las oculta de la consola.

using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Text;
using System.Text.RegularExpressions;
using Newtonsoft.Json;
using Oxide.Core;
using Oxide.Game.Rust.Cui;
using UnityEngine;

namespace Oxide.Plugins
{
    [Info("OxidianBridge", "Oxidian", "1.6.1")]
    [Description("Puente entre Oxidian y el servidor: inventarios, equipos, mapa en vivo, vigilancia, rates, eventos y herramientas de staff")]
    public class OxidianBridge : RustPlugin
    {
        private const string Prefix = "RPANEL|";
        private int _seq;

        // Moderación de chat (la configura el panel por RCON)
        private Regex _filter;
        private string _blockedMsg = "";
        private string _mutedMsg = "";
        private readonly Dictionary<string, float> _muted = new Dictionary<string, float>(); // steamid -> hasta (0 = indefinido)

        #region Eventos

        private void Emit(string type, Dictionary<string, object> data)
        {
            data["type"] = type;
            data["t"] = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            data["id"] = DateTime.UtcNow.Ticks.ToString() + "-" + (++_seq);
            Debug.Log(Prefix + JsonConvert.SerializeObject(data));
        }

        private static bool IsRealPlayer(BasePlayer p)
        {
            return p != null && !p.IsNpc && p.UserIDString.Length == 17 && p.UserIDString.StartsWith("7656");
        }

        private static string Pos(Vector3 v)
        {
            return $"{v.x:0} {v.y:0} {v.z:0}";
        }

        private static string WeaponOf(HitInfo info)
        {
            var item = info?.Weapon?.GetItem();
            if (item != null) return item.info.shortname;
            return info?.WeaponPrefab != null ? info.WeaponPrefab.ShortPrefabName : "desconocida";
        }

        // Infracciones detectadas por el antihack nativo de Rust (no se bloquea nada, solo se informa)
        private object OnPlayerViolation(BasePlayer player, AntiHackType type, float amount)
        {
            if (!IsRealPlayer(player)) return null;
            Emit("violation", new Dictionary<string, object>
            {
                ["steamid"] = player.UserIDString,
                ["name"] = player.displayName,
                ["kind"] = type.ToString(),
                ["amount"] = Math.Round(amount, 2),
                ["pos"] = Pos(player.transform.position),
            });
            return null;
        }

        // Conexión de un jugador (permite comprobar su perfil de Steam al momento)
        private void OnPlayerConnected(BasePlayer player)
        {
            if (!IsRealPlayer(player)) return;
            Emit("connect", new Dictionary<string, object>
            {
                ["steamid"] = player.UserIDString,
                ["name"] = player.displayName,
                ["ip"] = player.net?.connection?.ipaddress ?? "",
            });
        }

        // Reportes enviados por los jugadores con F7
        private void OnPlayerReported(BasePlayer reporter, string targetName, string targetId, string subject, string message, string type)
        {
            Emit("report", new Dictionary<string, object>
            {
                ["steamid"] = targetId,
                ["name"] = targetName,
                ["reporter"] = reporter != null ? reporter.UserIDString : "",
                ["reporterName"] = reporter != null ? reporter.displayName : "",
                ["subject"] = subject ?? "",
                ["message"] = message ?? "",
                ["kind"] = type ?? "",
            });
            NotifyStaffReport(targetName);
        }

        // Impactos de proyectil entre jugadores reales
        private void OnPlayerAttack(BasePlayer attacker, HitInfo info)
        {
            if (!IsRealPlayer(attacker) || info == null || !info.IsProjectile()) return;
            var victim = info.HitEntity as BasePlayer;
            if (!IsRealPlayer(victim) || victim == attacker) return;
            var distance = info.ProjectileDistance > 0 ? info.ProjectileDistance : Vector3.Distance(attacker.eyes.position, info.HitPositionWorld);
            Emit("hit", new Dictionary<string, object>
            {
                ["steamid"] = attacker.UserIDString,
                ["name"] = attacker.displayName,
                ["victim"] = victim.UserIDString,
                ["victimName"] = victim.displayName,
                ["headshot"] = info.isHeadshot,
                ["distance"] = Math.Round(distance, 1),
                ["weapon"] = WeaponOf(info),
            });
        }

        // Muertes de jugadores causadas por otro jugador
        private void OnPlayerDeath(BasePlayer player, HitInfo info)
        {
            var killer = info?.InitiatorPlayer;
            if (!IsRealPlayer(player) || !IsRealPlayer(killer) || killer == player) return;
            Emit("kill", new Dictionary<string, object>
            {
                ["steamid"] = killer.UserIDString,
                ["name"] = killer.displayName,
                ["victim"] = player.UserIDString,
                ["victimName"] = player.displayName,
                ["headshot"] = info.isHeadshot,
                ["distance"] = Math.Round(Vector3.Distance(killer.transform.position, player.transform.position), 1),
                ["weapon"] = WeaponOf(info),
            });
        }

        #endregion

        #region Inventario (solo consola del servidor / RCON)

        private static BasePlayer FindPlayer(string id)
        {
            ulong uid;
            if (!ulong.TryParse(id, out uid)) return null;
            return BasePlayer.FindByID(uid) ?? BasePlayer.FindSleeping(uid);
        }

        private static ItemContainer ContainerOf(BasePlayer p, string name)
        {
            switch (name)
            {
                case "main": return p.inventory.containerMain;
                case "belt": return p.inventory.containerBelt;
                case "wear": return p.inventory.containerWear;
                default: return null;
            }
        }

        private static object Dump(ItemContainer c)
        {
            if (c == null) return new { capacity = 0, items = new List<object>() };
            var items = c.itemList.Select(item => (object)new
            {
                slot = item.position,
                shortname = item.info.shortname,
                name = item.info.displayName.english,
                amount = item.amount,
                skin = item.skin,
                condition = item.hasCondition ? Math.Round(item.conditionNormalized, 3) : -1,
                ammo = (item.GetHeldEntity() as BaseProjectile)?.primaryMagazine?.contents ?? -1,
                mods = item.contents?.itemList?.Select(s => s.info.displayName.english).ToList(),
            }).ToList();
            return new { capacity = c.capacity, items };
        }

        private static string Reply(object o) { return JsonConvert.SerializeObject(o); }

        [ConsoleCommand("oxidian.ping")]
        private void CmdPing(ConsoleSystem.Arg arg)
        {
            if (arg.Connection != null) return;
            arg.ReplyWith(Reply(new { ok = true, version = Version.ToString() }));
        }

        [ConsoleCommand("oxidian.inventory")]
        private void CmdInventory(ConsoleSystem.Arg arg)
        {
            if (arg.Connection != null) return;
            var p = FindPlayer(arg.GetString(0));
            if (p == null) { arg.ReplyWith(Reply(new { error = "player_not_found" })); return; }
            arg.ReplyWith(Reply(new
            {
                steamid = p.UserIDString,
                name = p.displayName,
                online = p.IsConnected,
                sleeping = p.IsSleeping(),
                dead = p.IsDead(),
                health = Math.Round(p.health, 1),
                position = Pos(p.transform.position),
                wear = Dump(p.inventory.containerWear),
                belt = Dump(p.inventory.containerBelt),
                main = Dump(p.inventory.containerMain),
            }));
        }

        [ConsoleCommand("oxidian.inventory.remove")]
        private void CmdRemove(ConsoleSystem.Arg arg)
        {
            if (arg.Connection != null) return;
            var p = FindPlayer(arg.GetString(0));
            if (p == null) { arg.ReplyWith(Reply(new { error = "player_not_found" })); return; }
            var c = ContainerOf(p, arg.GetString(1));
            var item = c?.GetSlot(arg.GetInt(2, -1));
            if (item == null) { arg.ReplyWith(Reply(new { error = "empty_slot" })); return; }
            var name = item.info.displayName.english;
            item.RemoveFromContainer();
            item.Remove();
            arg.ReplyWith(Reply(new { ok = true, removed = name }));
        }

        [ConsoleCommand("oxidian.inventory.clear")]
        private void CmdClear(ConsoleSystem.Arg arg)
        {
            if (arg.Connection != null) return;
            var p = FindPlayer(arg.GetString(0));
            if (p == null) { arg.ReplyWith(Reply(new { error = "player_not_found" })); return; }
            p.inventory.Strip();
            arg.ReplyWith(Reply(new { ok = true }));
        }

        #endregion

        #region Equipos y armarios

        [ConsoleCommand("oxidian.teams")]
        private void CmdTeams(ConsoleSystem.Arg arg)
        {
            if (arg.Connection != null) return;
            var teams = new List<object>();
            foreach (var team in RelationshipManager.ServerInstance.teams.Values)
            {
                if (team == null || team.members.Count == 0) continue;
                teams.Add(new
                {
                    id = team.teamID.ToString(),
                    leader = team.teamLeader.ToString(),
                    members = team.members.Select(m =>
                    {
                        var p = BasePlayer.FindByID(m) ?? BasePlayer.FindSleeping(m);
                        return (object)new { steamid = m.ToString(), name = p != null ? p.displayName : m.ToString(), online = p != null && p.IsConnected };
                    }).ToList(),
                });
            }
            // Armarios con dos o más jugadores autorizados
            var cupboards = new List<object>();
            foreach (var tc in BaseNetworkable.serverEntities.OfType<BuildingPrivlidge>())
            {
                var ids = new List<string>();
                foreach (var a in tc.authorizedPlayers)
                {
                    object o = a;
                    if (o is ulong u) ids.Add(u.ToString());
                }
                if (ids.Count < 2) continue;
                cupboards.Add(new { id = tc.net.ID.ToString(), pos = Pos(tc.transform.position), authed = ids });
            }
            arg.ReplyWith(Reply(new { teams, cupboards }));
        }

        #endregion

        #region Mapa en vivo

        [ConsoleCommand("oxidian.map")]
        private void CmdMap(ConsoleSystem.Arg arg)
        {
            if (arg.Connection != null) return;
            int width, height;
            Color background;
            // Valores por defecto de MapImageRenderer: 0,5 píxeles por metro y 500 PÍXELES de océano a cada lado
            const float scale = 0.5f;
            const int oceanMargin = 500;
            var bytes = MapImageRenderer.Render(out width, out height, out background);
            if (bytes == null) { arg.ReplyWith(Reply(new { error = "map_render" })); return; }
            var monuments = TerrainMeta.Path != null
                ? TerrainMeta.Path.Monuments.Where(m => m != null && m.displayPhrase != null && !string.IsNullOrEmpty(m.displayPhrase.english))
                    .Select(m => (object)new { name = m.displayPhrase.english, prefab = m.name, x = Math.Round(m.transform.position.x), z = Math.Round(m.transform.position.z) }).ToList()
                : new List<object>();
            arg.ReplyWith(Reply(new
            {
                image = Convert.ToBase64String(bytes),
                width, height,
                scale, oceanMargin,
                paths = MapPaths(),
                worldSize = (int)World.Size,
                seed = (long)World.Seed,
                monuments,
            }));
        }

        // Rutas del mapa (carreteras, vías, ríos, tendido eléctrico) simplificadas: [x1,z1,x2,z2,…] por tramo
        private static List<int[]> Simplify(List<PathList> lists, float minStep)
        {
            var result = new List<int[]>();
            if (lists == null) return result;
            foreach (var pl in lists)
            {
                var pts = pl?.Path?.Points;
                if (pts == null || pts.Length < 2) continue;
                var flat = new List<int>();
                Vector3 last = pts[0];
                flat.Add((int)Math.Round(last.x)); flat.Add((int)Math.Round(last.z));
                for (int i = 1; i < pts.Length; i++)
                {
                    var p = pts[i];
                    if (i < pts.Length - 1 && (new Vector2(p.x - last.x, p.z - last.z)).sqrMagnitude < minStep * minStep) continue;
                    flat.Add((int)Math.Round(p.x)); flat.Add((int)Math.Round(p.z));
                    last = p;
                }
                if (flat.Count >= 4) result.Add(flat.ToArray());
            }
            return result;
        }

        private static object MapPaths()
        {
            var tp = TerrainMeta.Path;
            if (tp == null) return null;
            return new
            {
                roads = Simplify(tp.Roads, 15f),
                rails = Simplify(tp.Rails, 15f),
                rivers = Simplify(tp.Rivers, 20f),
                power = Simplify(tp.Powerlines, 25f),
            };
        }

        [ConsoleCommand("oxidian.positions")]
        private void CmdPositions(ConsoleSystem.Arg arg)
        {
            if (arg.Connection != null) return;
            Func<BasePlayer, object> dump = p => new
            {
                steamid = p.UserIDString,
                name = p.displayName,
                x = Math.Round(p.transform.position.x, 1),
                z = Math.Round(p.transform.position.z, 1),
                rot = Math.Round(p.eyes != null ? p.eyes.rotation.eulerAngles.y : 0f),
                team = p.currentTeam.ToString(),
                health = Math.Round(p.health),
                dead = p.IsDead(),
            };
            var events = new List<object>();
            foreach (var e in BaseNetworkable.serverEntities.OfType<BaseEntity>())
            {
                string kind = null;
                if (e is CargoShip) kind = "cargo";
                else if (e is PatrolHelicopter) kind = "heli";
                else if (e is BradleyAPC) kind = "bradley";
                else if (e is CH47HelicopterAIController) kind = "chinook";
                if (kind == null) continue;
                events.Add(new { kind, x = Math.Round(e.transform.position.x), z = Math.Round(e.transform.position.z) });
            }
            arg.ReplyWith(Reply(new
            {
                players = BasePlayer.activePlayerList.Where(IsRealPlayer).Select(dump).ToList(),
                sleepers = BasePlayer.sleepingPlayerList.Where(IsRealPlayer).Select(dump).ToList(),
                events,
            }));
        }

        #endregion

        #region Chat

        private static string Normalize(string s)
        {
            var d = (s ?? "").ToLowerInvariant().Normalize(NormalizationForm.FormD);
            var sb = new StringBuilder(d.Length);
            foreach (var c in d) if (CharUnicodeInfo.GetUnicodeCategory(c) != UnicodeCategory.NonSpacingMark) sb.Append(c);
            return sb.ToString();
        }

        // Bloquea mensajes de jugadores silenciados o con palabras del filtro antes de que se publiquen
        private object OnPlayerChat(BasePlayer player, string message, ConVar.Chat.ChatChannel channel)
        {
            if (!IsRealPlayer(player)) return null;
            float until;
            if (_muted.TryGetValue(player.UserIDString, out until))
            {
                if (until <= 0f || until > Time.realtimeSinceStartup)
                {
                    if (!string.IsNullOrEmpty(_mutedMsg)) player.ChatMessage(_mutedMsg);
                    return true;
                }
                _muted.Remove(player.UserIDString);
            }
            if (_filter == null) return null;
            var m = _filter.Match(Normalize(message));
            if (!m.Success) return null;
            if (!string.IsNullOrEmpty(_blockedMsg)) player.ChatMessage(_blockedMsg);
            Emit("chatblock", new Dictionary<string, object>
            {
                ["steamid"] = player.UserIDString,
                ["name"] = player.displayName,
                ["message"] = message,
                ["word"] = m.Groups.Count > 2 ? m.Groups[2].Value : m.Value.Trim(),
                ["channel"] = (int)channel,
            });
            return true;
        }

        private static string FromB64(string s)
        {
            try { return Encoding.UTF8.GetString(Convert.FromBase64String(s ?? "")); } catch { return ""; }
        }

        [ConsoleCommand("oxidian.chatfilter")]
        private void CmdChatFilter(ConsoleSystem.Arg arg)
        {
            if (arg.Connection != null) return;
            var cfg = JsonConvert.DeserializeObject<Dictionary<string, string>>(FromB64(arg.GetString(0))) ?? new Dictionary<string, string>();
            string pattern, msg, muted;
            cfg.TryGetValue("pattern", out pattern);
            cfg.TryGetValue("message", out msg);
            cfg.TryGetValue("mutedMessage", out muted);
            try { _filter = string.IsNullOrEmpty(pattern) ? null : new Regex(pattern, RegexOptions.IgnoreCase | RegexOptions.CultureInvariant); }
            catch { _filter = null; arg.ReplyWith(Reply(new { error = "bad_pattern" })); return; }
            _blockedMsg = msg ?? "";
            _mutedMsg = muted ?? "";
            arg.ReplyWith(Reply(new { ok = true }));
        }

        // oxidian.mute <steamid> <segundos>: 0 = indefinido, -1 = quitar
        [ConsoleCommand("oxidian.mute")]
        private void CmdMute(ConsoleSystem.Arg arg)
        {
            if (arg.Connection != null) return;
            var id = arg.GetString(0);
            var secs = arg.GetInt(1, 0);
            if (secs < 0) _muted.Remove(id);
            else _muted[id] = secs == 0 ? 0f : Time.realtimeSinceStartup + secs;
            arg.ReplyWith(Reply(new { ok = true }));
        }

        // oxidian.pm <steamid> <texto en base64>
        [ConsoleCommand("oxidian.pm")]
        private void CmdPm(ConsoleSystem.Arg arg)
        {
            if (arg.Connection != null) return;
            var p = FindPlayer(arg.GetString(0));
            if (p == null || !p.IsConnected) { arg.ReplyWith(Reply(new { error = "player_offline" })); return; }
            p.ChatMessage(FromB64(arg.GetString(1)));
            arg.ReplyWith(Reply(new { ok = true, name = p.displayName }));
        }

        #endregion

        #region Rates (multiplicadores) y eventos

        private class Rates
        {
            public float gather = 1f;
            public float pickup = 1f;
            public float quarry = 1f;
            public float craft = 1f;
        }

        private const string RatesFile = "OxidianBridge_rates";
        private Rates _rates = new Rates();
        private readonly Dictionary<int, float> _bpTimes = new Dictionary<int, float>(); // itemid -> tiempo original

        private void OnServerInitialized()
        {
            try { _rates = Interface.Oxide.DataFileSystem.ReadObject<Rates>(RatesFile) ?? new Rates(); }
            catch { _rates = new Rates(); }
            ApplyCraft();
        }

        private void Unload()
        {
            foreach (var p in BasePlayer.activePlayerList) CuiHelper.DestroyUi(p, UiRoot);
            // Deja los tiempos de crafteo como estaban
            foreach (var bp in ItemManager.bpList)
            {
                float orig;
                if (bp?.targetItem != null && _bpTimes.TryGetValue(bp.targetItem.itemid, out orig)) bp.time = orig;
            }
        }

        private void ApplyCraft()
        {
            foreach (var bp in ItemManager.bpList)
            {
                if (bp == null || bp.targetItem == null) continue;
                float orig;
                if (!_bpTimes.TryGetValue(bp.targetItem.itemid, out orig)) { orig = bp.time; _bpTimes[bp.targetItem.itemid] = orig; }
                bp.time = _rates.craft > 0f ? orig / _rates.craft : orig;
            }
        }

        private static void Scale(Item item, float mult)
        {
            if (item == null || Math.Abs(mult - 1f) < 0.001f) return;
            item.amount = Math.Max(1, (int)Math.Round(item.amount * mult));
        }

        // Árboles, piedras, menas y animales
        private void OnDispenserGather(ResourceDispenser dispenser, BaseEntity entity, Item item)
        {
            var p = entity as BasePlayer;
            if (p == null || !IsRealPlayer(p)) return;
            Scale(item, _rates.gather);
        }

        private void OnDispenserBonus(ResourceDispenser dispenser, BasePlayer player, Item item)
        {
            if (!IsRealPlayer(player)) return;
            Scale(item, _rates.gather);
        }

        // Objetos que se recogen del suelo (cáñamo, setas, piedras y madera sueltas…)
        private void OnCollectiblePickup(CollectibleEntity collectible, BasePlayer player)
        {
            if (collectible?.itemList == null || !IsRealPlayer(player) || Math.Abs(_rates.pickup - 1f) < 0.001f) return;
            foreach (var ia in collectible.itemList)
                if (ia != null) ia.amount = Math.Max(1f, (float)Math.Round(ia.amount * _rates.pickup));
        }

        // Cultivos
        private void OnGrowableGathered(GrowableEntity plant, Item item, BasePlayer player)
        {
            Scale(item, _rates.pickup);
        }

        // Canteras, excavadora y cargas de prospección
        private void OnQuarryGather(MiningQuarry quarry, Item item) { Scale(item, _rates.quarry); }
        private void OnExcavatorGather(ExcavatorArm arm, Item item) { Scale(item, _rates.quarry); }
        private void OnSurveyGather(SurveyCharge survey, Item item) { Scale(item, _rates.quarry); }

        // oxidian.rates <json en base64>
        [ConsoleCommand("oxidian.rates")]
        private void CmdRates(ConsoleSystem.Arg arg)
        {
            if (arg.Connection != null) return;
            Rates r;
            try { r = JsonConvert.DeserializeObject<Rates>(FromB64(arg.GetString(0))); } catch { r = null; }
            if (r == null) { arg.ReplyWith(Reply(new { error = "bad_rates" })); return; }
            Func<float, float> clamp = v => Mathf.Clamp(v, 0.1f, 100f);
            _rates = new Rates { gather = clamp(r.gather), pickup = clamp(r.pickup), quarry = clamp(r.quarry), craft = clamp(r.craft) };
            Interface.Oxide.DataFileSystem.WriteObject(RatesFile, _rates);
            ApplyCraft();
            arg.ReplyWith(Reply(new { ok = true, rates = _rates }));
        }

        private static readonly Dictionary<string, string> EventPrefabs = new Dictionary<string, string>
        {
            { "cargo", "assets/content/vehicles/boats/cargoship/cargoshiptest.prefab" },
            { "heli", "assets/prefabs/npc/patrol helicopter/patrolhelicopter.prefab" },
            { "airdrop", "assets/prefabs/npc/cargo plane/cargo_plane.prefab" },
            { "chinook", "assets/prefabs/npc/ch47/ch47scientists.entity.prefab" },
        };

        // oxidian.event <cargo|heli|airdrop|chinook>
        [ConsoleCommand("oxidian.event")]
        private void CmdEvent(ConsoleSystem.Arg arg)
        {
            if (arg.Connection != null) return;
            var type = arg.GetString(0);
            string prefab;
            if (!EventPrefabs.TryGetValue(type, out prefab)) { arg.ReplyWith(Reply(new { error = "bad_event" })); return; }
            var half = TerrainMeta.Size.x / 2f;
            var pos = Vector3.zero;
            if (type == "heli" || type == "chinook") pos = new Vector3(UnityEngine.Random.Range(-half, half) * 0.6f, 200f, half * 0.9f);
            var ent = GameManager.server.CreateEntity(prefab, pos, Quaternion.identity);
            if (ent == null) { arg.ReplyWith(Reply(new { error = "event_failed" })); return; }
            // El carguero necesita saber que es un evento para elegir su ruta por el mar
            if (type == "cargo") ent.SendMessage("TriggeredEventSpawn", SendMessageOptions.DontRequireReceiver);
            ent.Spawn();
            arg.ReplyWith(Reply(new { ok = true, type }));
        }

        #endregion
        #region Herramientas de staff en el juego (/staff)

        // Dos niveles por permiso: oxidian.mod (moderador) y oxidian.admin (todo). El panel los concede y
        // envía por RCON los tickets, las advertencias y los textos en el idioma elegido. Las sanciones las
        // ejecuta el panel (quedan en la ficha del jugador y en el registro de actividad).
        private const string PermMod = "oxidian.mod";
        private const string PermAdmin = "oxidian.admin";
        private const string PermSkipQueue = "oxidian.skipqueue";
        private const string UiRoot = "oxs.root";
        private const int PageSize = 12;

        private class StaffTicket { public int id; public string sid; public string name; public int n; public int r; public string subj; }
        private class StaffData
        {
            public Dictionary<string, string> t = new Dictionary<string, string>();
            public List<StaffTicket> tickets = new List<StaffTicket>();
            public Dictionary<string, int> warns = new Dictionary<string, int>();
        }
        private class StaffUi { public string tab = "players"; public int page; public string sel = ""; public string reason = ""; public string confirm = ""; public float confirmAt; }

        private StaffData _staff = new StaffData();
        private readonly Dictionary<ulong, StaffUi> _ui = new Dictionary<ulong, StaffUi>();

        // Textos de reserva si el panel aún no ha enviado los suyos
        private static readonly Dictionary<string, string> StaffFallback = new Dictionary<string, string>
        {
            { "title", "OXIDIAN STAFF" }, { "lvl.mod", "Moderator" }, { "lvl.admin", "Admin" }, { "tab.players", "Players" },
            { "tab.reports", "Reports ({n})" }, { "tab.world", "World" }, { "close", "Close" }, { "prev", "‹" }, { "next", "›" },
            { "pick", "Pick a player from the list" }, { "health", "Health" }, { "warns", "Warnings" }, { "team", "Team" },
            { "muted", "Muted" }, { "sleeping", "Sleeping" }, { "reason", "Reason (optional):" },
            { "a.tp", "Go to" }, { "a.bring", "Bring here" }, { "a.heal", "Heal" }, { "a.warn", "Warn" }, { "a.mute", "Mute 30 min" },
            { "a.unmute", "Unmute" }, { "a.kick", "Kick" }, { "a.tempban1", "Ban 1 day" }, { "a.tempban7", "Ban 7 days" }, { "a.ban", "Ban" },
            { "confirm", "Sure? Click again" }, { "noReports", "No pending reports" }, { "rep.line", "{n} reports · {r} players" },
            { "r.none", "Close" }, { "r.warn", "Warn + close" }, { "r.kick", "Kick + close" }, { "r.tempban", "Ban 1 d + close" },
            { "w.time", "Time" }, { "w.day", "Day" }, { "w.night", "Night" }, { "w.weather", "Weather" }, { "w.clear", "Clear" }, { "w.storm", "Storm" },
            { "w.events", "Events" }, { "w.cargo", "Cargo ship" }, { "w.heli", "Patrol heli" }, { "w.airdrop", "Airdrop" }, { "w.chinook", "Chinook" },
            { "sent", "<color=#5bb5a2>[Staff]</color> Sent to the panel…" }, { "noperm", "You do not have staff permissions." },
            { "offline", "That player is not on the server." }, { "notify", "<color=#e0a93b>[Staff]</color> New F7 report about {name}. Type /staff" },
            { "done.tp", "<color=#5bb5a2>[Staff]</color> Teleported to {name}." }, { "done.bring", "<color=#5bb5a2>[Staff]</color> {name} brought to you." },
            { "done.heal", "<color=#5bb5a2>[Staff]</color> {name} healed." },
        };

        private string T(string key)
        {
            string s;
            if (_staff.t != null && _staff.t.TryGetValue(key, out s) && !string.IsNullOrEmpty(s)) return s;
            return StaffFallback.TryGetValue(key, out s) ? s : key;
        }

        private void Init()
        {
            permission.RegisterPermission(PermMod, this);
            permission.RegisterPermission(PermAdmin, this);
            permission.RegisterPermission(PermSkipQueue, this);
        }

        // Prioridad en la cola: quien tenga oxidian.skipqueue (por ejemplo el grupo VIP) entra sin esperar.
        // No cambia el juego, así que vale también para servidores tipo vanilla.
        private object CanBypassQueue(Network.Connection connection)
        {
            if (connection != null && permission.UserHasPermission(connection.userid.ToString(), PermSkipQueue)) return true;
            return null;
        }

        private bool IsAdminStaff(BasePlayer p) { return p != null && permission.UserHasPermission(p.UserIDString, PermAdmin); }
        private bool IsStaff(BasePlayer p) { return p != null && (IsAdminStaff(p) || permission.UserHasPermission(p.UserIDString, PermMod)); }

        // Aviso a los moderadores conectados cuando llega un F7
        private void NotifyStaffReport(string targetName)
        {
            foreach (var p in BasePlayer.activePlayerList)
                if (IsStaff(p)) p.ChatMessage(T("notify").Replace("{name}", targetName ?? "?"));
        }

        [ChatCommand("staff")]
        private void ChatStaff(BasePlayer player, string command, string[] args)
        {
            if (!IsStaff(player)) { player.ChatMessage(T("noperm")); return; }
            StaffUi st;
            if (!_ui.TryGetValue(player.userID, out st)) { st = new StaffUi(); _ui[player.userID] = st; }
            DrawStaff(player);
        }

        // oxidian.staffdata <json en base64>: tickets, advertencias y textos que manda el panel
        [ConsoleCommand("oxidian.staffdata")]
        private void CmdStaffData(ConsoleSystem.Arg arg)
        {
            if (arg.Connection != null) return;
            StaffData d;
            try { d = JsonConvert.DeserializeObject<StaffData>(FromB64(arg.GetString(0))); } catch { d = null; }
            if (d == null) { arg.ReplyWith(Reply(new { error = "bad_data" })); return; }
            _staff = d;
            foreach (var id in _ui.Keys.ToList())
            {
                var p = BasePlayer.FindByID(id);
                if (p != null && p.IsConnected && IsStaff(p)) DrawStaff(p); else _ui.Remove(id);
            }
            arg.ReplyWith(Reply(new { ok = true, open = _ui.Count }));
        }

        // Botones de la interfaz: oxidian.staff <close|tab|page|sel|reason|act|ticket|world> …
        [ConsoleCommand("oxidian.staff")]
        private void CmdStaffUi(ConsoleSystem.Arg arg)
        {
            var player = arg.Player();
            if (player == null) return;
            if (!IsStaff(player)) { CuiHelper.DestroyUi(player, UiRoot); _ui.Remove(player.userID); return; }
            StaffUi st;
            if (!_ui.TryGetValue(player.userID, out st)) { st = new StaffUi(); _ui[player.userID] = st; }
            var sub = arg.GetString(0);
            switch (sub)
            {
                case "close": CuiHelper.DestroyUi(player, UiRoot); _ui.Remove(player.userID); return;
                case "tab": st.tab = arg.GetString(1, "players"); st.confirm = ""; break;
                case "page": st.page = Math.Max(0, arg.GetInt(1, 0)); break;
                case "sel": st.sel = arg.GetString(1); st.confirm = ""; break;
                case "reason":
                    st.reason = arg.Args != null && arg.Args.Length > 1 ? string.Join(" ", arg.Args.Skip(1).ToArray()) : "";
                    if (st.reason.Length > 100) st.reason = st.reason.Substring(0, 100);
                    return; // no se redibuja para no perder el foco del campo
                case "act": StaffAct(player, st, arg.GetString(1), arg.GetString(2)); break;
                case "ticket": StaffTicketAct(player, st, arg.GetInt(1, 0), arg.GetString(2)); break;
                case "world": StaffWorld(player, arg.GetString(1)); break;
            }
            DrawStaff(player);
        }

        private static readonly HashSet<string> ModActs = new HashSet<string> { "tp", "warn", "mute", "unmute", "kick" };
        private static readonly HashSet<string> AdminActs = new HashSet<string> { "bring", "heal", "tempban1", "tempban7", "ban" };
        private static readonly HashSet<string> ConfirmActs = new HashSet<string> { "kick", "tempban1", "tempban7", "ban" };

        private bool NeedsConfirm(BasePlayer staff, StaffUi st, string key)
        {
            if (st.confirm == key && Time.realtimeSinceStartup - st.confirmAt < 6f) { st.confirm = ""; return false; }
            st.confirm = key; st.confirmAt = Time.realtimeSinceStartup;
            return true;
        }

        private void EmitStaff(BasePlayer staff, string action, string targetId, string targetName, Dictionary<string, object> extra = null)
        {
            var d = new Dictionary<string, object>
            {
                ["by"] = staff.UserIDString, ["byName"] = staff.displayName, ["level"] = IsAdminStaff(staff) ? "admin" : "mod",
                ["action"] = action, ["target"] = targetId ?? "", ["targetName"] = targetName ?? "",
            };
            if (extra != null) foreach (var kv in extra) d[kv.Key] = kv.Value;
            Emit("staffaction", d);
        }

        private void StaffAct(BasePlayer staff, StaffUi st, string action, string targetId)
        {
            if (!ModActs.Contains(action) && !AdminActs.Contains(action)) return;
            if (AdminActs.Contains(action) && !IsAdminStaff(staff)) return;
            var target = FindPlayer(targetId);
            if (target == null) { staff.ChatMessage(T("offline")); return; }
            if (ConfirmActs.Contains(action) && NeedsConfirm(staff, st, action + ":" + targetId)) return;
            var name = target.displayName;
            if (action == "tp")
            {
                staff.Teleport(target.transform.position + new Vector3(1.5f, 0.2f, 0f));
                staff.ChatMessage(T("done.tp").Replace("{name}", name));
                EmitStaff(staff, action, targetId, name, new Dictionary<string, object> { ["local"] = true });
                return;
            }
            if (action == "bring")
            {
                if (!target.IsConnected) { staff.ChatMessage(T("offline")); return; }
                target.Teleport(staff.transform.position + new Vector3(1.5f, 0.2f, 0f));
                staff.ChatMessage(T("done.bring").Replace("{name}", name));
                EmitStaff(staff, action, targetId, name, new Dictionary<string, object> { ["local"] = true });
                return;
            }
            if (action == "heal")
            {
                target.health = target.MaxHealth();
                if (target.metabolism != null)
                {
                    target.metabolism.bleeding.value = 0f;
                    target.metabolism.radiation_poison.value = 0f;
                    target.metabolism.SendChangesToClient();
                }
                target.SendNetworkUpdate();
                staff.ChatMessage(T("done.heal").Replace("{name}", name));
                EmitStaff(staff, action, targetId, name, new Dictionary<string, object> { ["local"] = true });
                return;
            }
            // El resto lo ejecuta el panel
            EmitStaff(staff, action, targetId, name, new Dictionary<string, object> { ["reason"] = st.reason ?? "" });
            staff.ChatMessage(T("sent"));
        }

        private void StaffTicketAct(BasePlayer staff, StaffUi st, int ticket, string resolution)
        {
            var allowed = IsAdminStaff(staff) ? new[] { "none", "warn", "kick", "tempban" } : new[] { "none", "warn", "kick" };
            if (ticket <= 0 || !allowed.Contains(resolution)) return;
            var tk = _staff.tickets?.FirstOrDefault(x => x.id == ticket);
            if (resolution != "none" && NeedsConfirm(staff, st, "t" + ticket + resolution)) return;
            EmitStaff(staff, "ticket", tk?.sid ?? "", tk?.name ?? "", new Dictionary<string, object> { ["ticket"] = ticket, ["resolution"] = resolution, ["reason"] = st.reason ?? "" });
            staff.ChatMessage(T("sent"));
        }

        private void StaffWorld(BasePlayer staff, string what)
        {
            if (!IsAdminStaff(staff)) return;
            var ok = new[] { "day", "night", "clear", "storm", "cargo", "heli", "airdrop", "chinook" };
            if (!ok.Contains(what)) return;
            EmitStaff(staff, "world", "", "", new Dictionary<string, object> { ["what"] = what });
            staff.ChatMessage(T("sent"));
        }

        // ---------- Dibujo de la ventana ----------
        private const string CBg = "0.07 0.09 0.11 0.97", CPanel = "0.12 0.15 0.18 1", CRow = "0.16 0.19 0.23 1", CRowSel = "0.22 0.33 0.32 1";
        private const string CPatina = "0.27 0.55 0.49 1", COxide = "0.72 0.33 0.14 1", CAmber = "0.70 0.50 0.15 1", CSteel = "0.24 0.28 0.33 1";
        private const string CText = "0.92 0.93 0.94 1", CMuted = "0.58 0.63 0.67 1";

        private static string A(float x, float y) { return string.Format(CultureInfo.InvariantCulture, "{0:0.####} {1:0.####}", x, y); }

        private static void UiBox(CuiElementContainer c, string parent, string name, string color, float x0, float y0, float x1, float y1)
        {
            c.Add(new CuiPanel { Image = { Color = color }, RectTransform = { AnchorMin = A(x0, y0), AnchorMax = A(x1, y1) } }, parent, name);
        }
        private static void UiText(CuiElementContainer c, string parent, string text, int size, string color, TextAnchor align, float x0, float y0, float x1, float y1)
        {
            c.Add(new CuiLabel { Text = { Text = text ?? "", FontSize = size, Color = color, Align = align }, RectTransform = { AnchorMin = A(x0, y0), AnchorMax = A(x1, y1) } }, parent);
        }
        private static void UiBtn(CuiElementContainer c, string parent, string text, string cmd, string color, float x0, float y0, float x1, float y1, int size = 12)
        {
            c.Add(new CuiButton
            {
                Button = { Command = cmd, Color = color },
                Text = { Text = text ?? "", FontSize = size, Align = TextAnchor.MiddleCenter, Color = CText },
                RectTransform = { AnchorMin = A(x0, y0), AnchorMax = A(x1, y1) },
            }, parent);
        }

        private void DrawStaff(BasePlayer player)
        {
            StaffUi st;
            if (!_ui.TryGetValue(player.userID, out st)) return;
            var admin = IsAdminStaff(player);
            if (st.tab == "world" && !admin) st.tab = "players";
            var c = new CuiElementContainer();
            c.Add(new CuiPanel { Image = { Color = "0 0 0 0.55" }, RectTransform = { AnchorMin = "0 0", AnchorMax = "1 1" }, CursorEnabled = true }, "Overlay", UiRoot);
            UiBox(c, UiRoot, "oxs.win", CBg, 0.16f, 0.12f, 0.84f, 0.88f);

            // Cabecera y pestañas
            UiText(c, "oxs.win", T("title"), 20, CText, TextAnchor.MiddleLeft, 0.025f, 0.91f, 0.4f, 0.98f);
            UiText(c, "oxs.win", admin ? T("lvl.admin") : T("lvl.mod"), 12, admin ? "0.88 0.66 0.23 1" : "0.45 0.79 0.71 1", TextAnchor.MiddleLeft, 0.25f, 0.91f, 0.45f, 0.98f);
            UiBtn(c, "oxs.win", "✕  " + T("close"), "oxidian.staff close", CSteel, 0.86f, 0.925f, 0.975f, 0.97f);
            var tabs = new List<KeyValuePair<string, string>>
            {
                new KeyValuePair<string, string>("players", T("tab.players")),
                new KeyValuePair<string, string>("reports", T("tab.reports").Replace("{n}", (_staff.tickets?.Count ?? 0).ToString())),
            };
            if (admin) tabs.Add(new KeyValuePair<string, string>("world", T("tab.world")));
            for (var i = 0; i < tabs.Count; i++)
            {
                var x = 0.025f + i * 0.17f;
                UiBtn(c, "oxs.win", tabs[i].Value, "oxidian.staff tab " + tabs[i].Key, st.tab == tabs[i].Key ? CPatina : CPanel, x, 0.845f, x + 0.16f, 0.895f, 13);
            }

            if (st.tab == "reports") DrawReports(c, st, admin);
            else if (st.tab == "world") DrawWorld(c);
            else DrawPlayers(c, st, admin);

            CuiHelper.DestroyUi(player, UiRoot);
            CuiHelper.AddUi(player, c);
        }

        private void DrawPlayers(CuiElementContainer c, StaffUi st, bool admin)
        {
            UiBox(c, "oxs.win", "oxs.list", CPanel, 0.025f, 0.04f, 0.33f, 0.825f);
            var list = BasePlayer.activePlayerList.Where(IsRealPlayer).OrderBy(p => p.displayName, StringComparer.OrdinalIgnoreCase).ToList();
            var pages = Math.Max(1, (list.Count + PageSize - 1) / PageSize);
            if (st.page >= pages) st.page = pages - 1;
            var rowH = 0.86f / PageSize;
            var shown = list.Skip(st.page * PageSize).Take(PageSize).ToList();
            for (var i = 0; i < shown.Count; i++)
            {
                var p = shown[i];
                var y1 = 0.98f - i * rowH;
                int w;
                var warn = _staff.warns != null && _staff.warns.TryGetValue(p.UserIDString, out w) && w > 0 ? "  <color=#e0a93b>⚠" + w + "</color>" : "";
                UiBtn(c, "oxs.list", Clip(p.displayName, 22) + warn, "oxidian.staff sel " + p.UserIDString, p.UserIDString == st.sel ? CRowSel : CRow, 0.03f, y1 - rowH + 0.006f, 0.97f, y1, 12);
            }
            UiBtn(c, "oxs.list", T("prev"), "oxidian.staff page " + Math.Max(0, st.page - 1), CSteel, 0.03f, 0.015f, 0.2f, 0.09f);
            UiText(c, "oxs.list", (st.page + 1) + " / " + pages + "  ·  " + list.Count, 11, CMuted, TextAnchor.MiddleCenter, 0.2f, 0.015f, 0.8f, 0.09f);
            UiBtn(c, "oxs.list", T("next"), "oxidian.staff page " + Math.Min(pages - 1, st.page + 1), CSteel, 0.8f, 0.015f, 0.97f, 0.09f);

            UiBox(c, "oxs.win", "oxs.det", CPanel, 0.345f, 0.04f, 0.975f, 0.825f);
            var target = string.IsNullOrEmpty(st.sel) ? null : FindPlayer(st.sel);
            if (target == null) { UiText(c, "oxs.det", T("pick"), 14, CMuted, TextAnchor.MiddleCenter, 0f, 0f, 1f, 1f); return; }

            UiText(c, "oxs.det", target.displayName, 18, CText, TextAnchor.MiddleLeft, 0.04f, 0.88f, 0.96f, 0.97f);
            int warns;
            _staff.warns.TryGetValue(target.UserIDString, out warns);
            var info = target.UserIDString + "   ·   " + T("health") + " " + Mathf.RoundToInt(target.health) +
                       "   ·   " + T("warns") + " " + warns + "   ·   " + T("team") + " " + (target.Team?.members.Count ?? 1) +
                       (_muted.ContainsKey(target.UserIDString) ? "   ·   <color=#e0a93b>" + T("muted") + "</color>" : "") +
                       (target.IsSleeping() ? "   ·   " + T("sleeping") : "");
            UiText(c, "oxs.det", info, 11, CMuted, TextAnchor.MiddleLeft, 0.04f, 0.8f, 0.96f, 0.88f);

            // Motivo (se usa en advertencias, silencios, expulsiones y baneos)
            UiText(c, "oxs.det", T("reason"), 11, CMuted, TextAnchor.MiddleLeft, 0.04f, 0.71f, 0.3f, 0.77f);
            UiBox(c, "oxs.det", "oxs.reason", "0.05 0.06 0.07 1", 0.3f, 0.705f, 0.96f, 0.775f);
            c.Add(new CuiElement
            {
                Parent = "oxs.reason",
                Components =
                {
                    new CuiInputFieldComponent { Text = st.reason ?? "", FontSize = 12, Align = TextAnchor.MiddleLeft, Color = CText, CharsLimit = 100, Command = "oxidian.staff reason" },
                    new CuiRectTransformComponent { AnchorMin = "0.02 0", AnchorMax = "0.98 1" },
                },
            });

            var acts = new List<string[]>
            {
                new[] { "tp", CSteel }, new[] { "warn", CAmber }, new[] { "mute", CAmber }, new[] { "unmute", CSteel }, new[] { "kick", COxide },
            };
            if (admin) acts.AddRange(new List<string[]> { new[] { "bring", CSteel }, new[] { "heal", CPatina }, new[] { "tempban1", COxide }, new[] { "tempban7", COxide }, new[] { "ban", "0.62 0.18 0.14 1" } });
            for (var i = 0; i < acts.Count; i++)
            {
                var col = i % 3; var row = i / 3;
                var x0 = 0.04f + col * 0.31f; var y1 = 0.64f - row * 0.13f;
                var key = acts[i][0] + ":" + target.UserIDString;
                var label = st.confirm == key ? T("confirm") : T("a." + acts[i][0]);
                UiBtn(c, "oxs.det", label, "oxidian.staff act " + acts[i][0] + " " + target.UserIDString, st.confirm == key ? "0.62 0.18 0.14 1" : acts[i][1], x0, y1 - 0.1f, x0 + 0.29f, y1, 13);
            }
        }

        private void DrawReports(CuiElementContainer c, StaffUi st, bool admin)
        {
            UiBox(c, "oxs.win", "oxs.rep", CPanel, 0.025f, 0.04f, 0.975f, 0.825f);
            var items = (_staff.tickets ?? new List<StaffTicket>()).Take(8).ToList();
            if (items.Count == 0) { UiText(c, "oxs.rep", T("noReports"), 14, CMuted, TextAnchor.MiddleCenter, 0f, 0f, 1f, 1f); return; }
            var rowH = 0.96f / 8f;
            var res = admin ? new[] { "none", "warn", "kick", "tempban" } : new[] { "none", "warn", "kick" };
            for (var i = 0; i < items.Count; i++)
            {
                var tk = items[i];
                var y1 = 0.98f - i * rowH; var y0 = y1 - rowH + 0.01f;
                var row = "oxs.r" + i;
                UiBox(c, "oxs.rep", row, CRow, 0.015f, y0, 0.985f, y1);
                UiText(c, row, "#" + tk.id + "  <b>" + Clip(tk.name, 24) + "</b>", 13, CText, TextAnchor.MiddleLeft, 0.015f, 0.5f, 0.41f, 1f);
                UiText(c, row, T("rep.line").Replace("{n}", tk.n.ToString()).Replace("{r}", tk.r.ToString()) + "  ·  " + Clip(tk.subj, 28), 11, tk.r > 1 ? "0.91 0.52 0.30 1" : CMuted, TextAnchor.MiddleLeft, 0.015f, 0f, 0.41f, 0.5f);
                UiBtn(c, row, T("a.tp"), "oxidian.staff act tp " + tk.sid, CSteel, 0.42f, 0.18f, 0.5f, 0.82f, 11);
                for (var j = 0; j < res.Length; j++)
                {
                    var x0 = 0.51f + j * 0.12f;
                    var key = "t" + tk.id + res[j];
                    UiBtn(c, row, st.confirm == key ? T("confirm") : T("r." + res[j]), "oxidian.staff ticket " + tk.id + " " + res[j],
                        st.confirm == key ? "0.62 0.18 0.14 1" : res[j] == "none" ? CPatina : res[j] == "warn" ? CAmber : COxide, x0, 0.18f, x0 + 0.115f, 0.82f, 11);
                }
            }
        }

        private void DrawWorld(CuiElementContainer c)
        {
            UiBox(c, "oxs.win", "oxs.wld", CPanel, 0.025f, 0.04f, 0.975f, 0.825f);
            var groups = new[]
            {
                new[] { "w.time", "day", "night" },
                new[] { "w.weather", "clear", "storm" },
                new[] { "w.events", "cargo", "heli", "airdrop", "chinook" },
            };
            for (var g = 0; g < groups.Length; g++)
            {
                var y1 = 0.92f - g * 0.3f;
                UiText(c, "oxs.wld", T(groups[g][0]), 14, CMuted, TextAnchor.MiddleLeft, 0.03f, y1 - 0.08f, 0.5f, y1);
                for (var i = 1; i < groups[g].Length; i++)
                {
                    var x0 = 0.03f + (i - 1) * 0.235f;
                    UiBtn(c, "oxs.wld", T("w." + groups[g][i]), "oxidian.staff world " + groups[g][i], g == 2 ? COxide : CSteel, x0, y1 - 0.22f, x0 + 0.22f, y1 - 0.1f, 14);
                }
            }
        }

        private static string Clip(string s, int n) { s = s ?? ""; return s.Length <= n ? s : s.Substring(0, n - 1) + "…"; }

        private void OnPlayerDisconnected(BasePlayer player, string reason) { if (player != null) _ui.Remove(player.userID); }

        #endregion

    }
}
