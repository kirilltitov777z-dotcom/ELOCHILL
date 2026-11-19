-- ============================================================
-- ELOCHILL — безлимитные проверки, серверная логика
-- Выполнить в Supabase -> SQL Editor -> New query -> Run
-- Файл идемпотентный: можно запускать повторно.
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

-- для уже существующей таблицы
ALTER TABLE public.leaderboard ADD COLUMN IF NOT EXISTS total_submissions INTEGER DEFAULT 0;

CREATE TABLE IF NOT EXISTS public.submissions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username TEXT NOT NULL,
  outcome TEXT NOT NULL,
  accepted BOOLEAN NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Уровень считается из Эло триггером
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

DROP POLICY IF EXISTS "Все видят таблицу" ON public.leaderboard;
DROP POLICY IF EXISTS "Каждый добавляет себя" ON public.leaderboard;
DROP POLICY IF EXISTS "Обновлять свои данные" ON public.leaderboard;
DROP POLICY IF EXISTS "read leaderboard" ON public.leaderboard;
CREATE POLICY "read leaderboard" ON public.leaderboard FOR SELECT USING (true);

REVOKE ALL ON TABLE public.leaderboard FROM anon, authenticated;
GRANT SELECT ON TABLE public.leaderboard TO anon, authenticated;
REVOKE ALL ON TABLE public.submissions FROM anon, authenticated;

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

-- Профиль: без кд и без лимитов, только счётчики
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

-- Проверка: без кд, без дневного максимума. Всегда принимает запрос.
CREATE OR REPLACE FUNCTION public.submit_result(p_username text, p_outcome text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_row public.leaderboard%ROWTYPE;
  v_today date := (now() AT TIME ZONE 'UTC')::date;
  v_accepted boolean;
  v_delta int;
BEGIN
  IF p_outcome NOT IN ('win', 'lose') THEN
    RETURN jsonb_build_object('error', 'Некорректный исход матча');
  END IF;

  SELECT * INTO v_row FROM public.leaderboard
  WHERE username = btrim(p_username) FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('error', 'Игрок не найден'); END IF;

  IF v_row.day_reset IS NULL OR (v_row.day_reset AT TIME ZONE 'UTC')::date <> v_today THEN
    UPDATE public.leaderboard SET submissions_today = 0, day_reset = now() WHERE id = v_row.id;
    v_row.submissions_today := 0;
  END IF;

  -- сервер решает: 80% одобрения
  v_accepted := random() < 0.8;
  v_delta := CASE WHEN p_outcome = 'win' THEN 50 ELSE -10 END;

  UPDATE public.leaderboard
    SET elo = CASE WHEN v_accepted THEN elo + v_delta ELSE elo END,
        last_submit = now(),
        submissions_today = submissions_today + 1,
        total_submissions = COALESCE(total_submissions, 0) + 1,
        updated_at = now()
    WHERE id = v_row.id
    RETURNING elo, level, submissions_today, total_submissions
      INTO v_row.elo, v_row.level, v_row.submissions_today, v_row.total_submissions;

  INSERT INTO public.submissions (username, outcome, accepted)
    VALUES (v_row.username, p_outcome, v_accepted);

  RETURN jsonb_build_object(
    'accepted', v_accepted,
    'outcome', p_outcome,
    'delta', CASE WHEN v_accepted THEN v_delta ELSE 0 END,
    'elo', v_row.elo,
    'level', v_row.level,
    'reason', CASE WHEN v_accepted THEN '' ELSE 'Не удалось распознать данные на скриншоте' END,
    'submissions_today', v_row.submissions_today,
    'total_submissions', v_row.total_submissions
  );
END;
$$;

REVOKE ALL ON FUNCTION public.get_or_create_user(text) FROM anon, authenticated;
REVOKE ALL ON FUNCTION public.get_profile(text) FROM anon, authenticated;
REVOKE ALL ON FUNCTION public.submit_result(text, text) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_or_create_user(text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_profile(text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.submit_result(text, text) TO anon, authenticated;
