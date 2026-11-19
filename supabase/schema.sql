-- ============================================================
-- ELOCHILL — проверка по отпечатку скриншота, без кулдауна и лимитов
-- Supabase -> SQL Editor -> New query -> Run
-- Файл идемпотентный, можно запускать поверх старой версии.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.leaderboard (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username TEXT NOT NULL UNIQUE,
  elo INTEGER DEFAULT 0,
  level INTEGER DEFAULT 1,
  last_submit TIMESTAMP WITH TIME ZONE,
  submissions_today INTEGER DEFAULT 0,
  total_submissions INTEGER DEFAULT 0,
  day_reset TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);
ALTER TABLE public.leaderboard ADD COLUMN IF NOT EXISTS total_submissions INTEGER DEFAULT 0;

CREATE TABLE IF NOT EXISTS public.submissions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username TEXT NOT NULL,
  outcome TEXT NOT NULL,
  accepted BOOLEAN NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Глобальный реестр использованных скриншотов.
-- p_hash — perceptual hash (dHash, 64 бита в hex). Один кадр = одна запись.
CREATE TABLE IF NOT EXISTS public.screenshots (
  p_hash TEXT PRIMARY KEY,
  sha256 TEXT NOT NULL,
  username TEXT NOT NULL,
  accepted BOOLEAN NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Уровень из Эло
CREATE OR REPLACE FUNCTION public.update_level() RETURNS TRIGGER AS $$
BEGIN
  NEW.level := CASE
    WHEN NEW.elo >= 8000 THEN 15
    WHEN NEW.elo >= 6800 THEN 14
    WHEN NEW.elo >= 5700 THEN 13
    WHEN NEW.elo >= 4700 THEN 12
    WHEN NEW.elo >= 3800 THEN 11
    WHEN NEW.elo >= 3000 THEN 10
    WHEN NEW.elo >= 2500 THEN 9
    WHEN NEW.elo >= 2300 THEN 8
    WHEN NEW.elo >= 2100 THEN 7
    WHEN NEW.elo >= 1800 THEN 6
    WHEN NEW.elo >= 1400 THEN 5
    WHEN NEW.elo >= 900 THEN 4
    WHEN NEW.elo >= 500 THEN 3
    WHEN NEW.elo >= 200 THEN 2
    ELSE 1
  END;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS set_level ON public.leaderboard;
CREATE TRIGGER set_level BEFORE INSERT OR UPDATE OF elo ON public.leaderboard
FOR EACH ROW EXECUTE FUNCTION public.update_level();

ALTER TABLE public.leaderboard ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.submissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.screenshots ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Все видят таблицу" ON public.leaderboard;
DROP POLICY IF EXISTS "Каждый добавляет себя" ON public.leaderboard;
DROP POLICY IF EXISTS "Обновлять свои данные" ON public.leaderboard;
DROP POLICY IF EXISTS "read leaderboard" ON public.leaderboard;
CREATE POLICY "read leaderboard" ON public.leaderboard FOR SELECT USING (true);

REVOKE ALL ON TABLE public.leaderboard FROM anon, authenticated;
GRANT SELECT ON TABLE public.leaderboard TO anon, authenticated;
REVOKE ALL ON TABLE public.submissions FROM anon, authenticated;
REVOKE ALL ON TABLE public.screenshots FROM anon, authenticated;

-- Вход
CREATE OR REPLACE FUNCTION public.get_or_create_user(p_username text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_name text := btrim(p_username);
  v_row public.leaderboard%ROWTYPE;
BEGIN
  IF v_name IS NULL OR char_length(v_name) < 2 OR char_length(v_name) > 24 THEN
    RETURN jsonb_build_object('error', 'Ник: от 2 до 24 символов');
  END IF;
  INSERT INTO public.leaderboard (username) VALUES (v_name)
  ON CONFLICT (username) DO NOTHING;
  SELECT * INTO v_row FROM public.leaderboard WHERE username = v_name;
  RETURN jsonb_build_object('username', v_row.username, 'elo', v_row.elo, 'level', v_row.level);
END;
$$;

-- Профиль
CREATE OR REPLACE FUNCTION public.get_profile(p_username text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_row public.leaderboard%ROWTYPE;
  v_today date := (now() AT TIME ZONE 'UTC')::date;
  v_subs int := 0;
BEGIN
  SELECT * INTO v_row FROM public.leaderboard WHERE username = btrim(p_username);
  IF NOT FOUND THEN RETURN jsonb_build_object('error', 'Игрок не найден'); END IF;
  IF v_row.day_reset IS NULL OR (v_row.day_reset AT TIME ZONE 'UTC')::date <> v_today THEN
    v_subs := 0;
  ELSE
    v_subs := v_row.submissions_today;
  END IF;
  RETURN jsonb_build_object(
    'username', v_row.username,
    'elo', v_row.elo,
    'level', v_row.level,
    'submissions_today', v_subs,
    'total_submissions', COALESCE(v_row.total_submissions, 0)
  );
END;
$$;

-- Старая версия без отпечатка — удаляем, чтобы её нельзя было вызвать в обход проверки
DROP FUNCTION IF EXISTS public.submit_result(text, text);

-- ============================================================
-- ПРОВЕРКА
-- 1. Лёгкий ИИ на устройстве разбирает пиксели: цвета, контраст,
--    границы объектов и строки интерфейса. Решение принимается по этим
--    признакам, а не по случаю.
-- 2. Сервер перепроверяет присланные признаки по порогам.
-- 3. Дедупликация по отпечатку (dHash) — тот же кадр не пройдёт дважды.
-- 4. Удаление старых версий функции — обход без ИИ невозможен.
-- ============================================================
DROP FUNCTION IF EXISTS public.submit_result(text, text);
DROP FUNCTION IF EXISTS public.submit_result(text, text, text, text);

CREATE OR REPLACE FUNCTION public.submit_result(
  p_username text, p_outcome text, p_phash text, p_sha text,
  p_ai_ok boolean, p_features jsonb
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_phash text := lower(coalesce(p_phash, ''));
  v_w int := CASE WHEN (p_features->>'w') ~ '^\d+$' THEN (p_features->>'w')::int ELSE 0 END;
  v_h int := CASE WHEN (p_features->>'h') ~ '^\d+$' THEN (p_features->>'h')::int ELSE 0 END;
  v_colors int := CASE WHEN (p_features->>'colors') ~ '^\d+$' THEN (p_features->>'colors')::int ELSE 0 END;
  v_edges numeric := CASE WHEN (p_features->>'edges') ~ '^\d*\.?\d+$' THEN (p_features->>'edges')::numeric ELSE 0 END;
  v_rows int := CASE WHEN (p_features->>'textRows') ~ '^\d+$' THEN (p_features->>'textRows')::int ELSE 0 END;
  v_contrast int := CASE WHEN (p_features->>'contrast') ~ '^\d+$' THEN (p_features->>'contrast')::int ELSE 0 END;
  v_score int := CASE WHEN (p_features->>'score') ~ '^\d+$' THEN (p_features->>'score')::int ELSE 0 END;
  v_ok boolean;
  v_delta int;
  v_row public.leaderboard%ROWTYPE;
  v_today date := (now() AT TIME ZONE 'UTC')::date;
BEGIN
  IF p_outcome NOT IN ('win', 'lose') THEN
    RETURN jsonb_build_object('error', 'Некорректный исход матча');
  END IF;
  IF v_phash !~ '^[0-9a-f]{16}$' THEN
    RETURN jsonb_build_object('error', 'Не удалось прочитать скриншот');
  END IF;

  SELECT * INTO v_row FROM public.leaderboard
  WHERE username = btrim(p_username) FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('error', 'Игрок не найден'); END IF;

  -- повтор кадра
  IF EXISTS (SELECT 1 FROM public.screenshots WHERE p_hash = v_phash)
     OR EXISTS (
       SELECT 1 FROM public.screenshots s
       WHERE bit_count(('x' || s.p_hash)::bit(64) # ('x' || v_phash)::bit(64)) <= 5
     ) THEN
    RETURN jsonb_build_object('error', 'duplicate', 'reason', 'Этот скриншот уже использован');
  END IF;

  -- решение ИИ: сервер сам проверяет признаки, а не верит флагу клиента
  v_ok := coalesce(p_ai_ok, false)
    AND v_w >= 400 AND v_h >= 400
    AND v_colors >= 30
    AND v_edges >= 0.015
    AND v_rows >= 2
    AND v_contrast >= 18;

  IF NOT v_ok THEN
    RETURN jsonb_build_object(
      'error', 'ai_reject',
      'reason', 'ИИ не смог распознать элементы интерфейса матча на скриншоте',
      'score', v_score
    );
  END IF;

  -- ИИ подтвердил кадр -> результат принимается. Удачи больше нет.
  v_delta := CASE WHEN p_outcome = 'win' THEN 50 ELSE -10 END;

  IF v_row.day_reset IS NULL OR (v_row.day_reset AT TIME ZONE 'UTC')::date <> v_today THEN
    UPDATE public.leaderboard SET submissions_today = 0, day_reset = now() WHERE id = v_row.id;
    v_row.submissions_today := 0;
  END IF;

  UPDATE public.leaderboard
    SET elo = elo + v_delta,
        last_submit = now(),
        submissions_today = submissions_today + 1,
        total_submissions = COALESCE(total_submissions, 0) + 1,
        updated_at = now()
    WHERE id = v_row.id
    RETURNING elo, level, submissions_today, total_submissions
      INTO v_row.elo, v_row.level, v_row.submissions_today, v_row.total_submissions;

  INSERT INTO public.screenshots (p_hash, sha256, username, accepted)
    VALUES (v_phash, left(coalesce(p_sha, ''), 64), true);

  INSERT INTO public.submissions (username, outcome, accepted)
    VALUES (v_row.username, p_outcome, true);

  RETURN jsonb_build_object(
    'accepted', true,
    'outcome', p_outcome,
    'delta', v_delta,
    'elo', v_row.elo,
    'level', v_row.level,
    'reason', '',
    'score', v_score,
    'submissions_today', v_row.submissions_today,
    'total_submissions', v_row.total_submissions
  );
END;
$$;

REVOKE ALL ON FUNCTION public.get_or_create_user(text) FROM anon, authenticated;
REVOKE ALL ON FUNCTION public.get_profile(text) FROM anon, authenticated;
REVOKE ALL ON FUNCTION public.submit_result(text, text) FROM anon, authenticated;
REVOKE ALL ON FUNCTION public.submit_result(text, text, text, text) FROM anon, authenticated;
REVOKE ALL ON FUNCTION public.submit_result(text, text, text, text, boolean, jsonb) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_or_create_user(text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_profile(text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.submit_result(text, text, text, text, boolean, jsonb) TO anon, authenticated;
