//go:build wasip1

package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path"
	"strings"
	"time"

	pb "github.com/schollz/progressbar/v3"
	"github.com/zyedidia/eget/home"
)

// This file provides stubs for wasm builds to avoid network calls.
// It reads from /tmp/<url> instead of making a network request.

func tokenFrom(s string) (string, error) {
	if strings.HasPrefix(s, "@") {
		f, err := home.Expand(s[1:])
		if err != nil {
			return "", err
		}
		b, err := os.ReadFile(f)
		return strings.TrimRight(string(b), "\r\n"), nil
	}
	return s, nil
}

var ErrNoToken = errors.New("no github token")

func getGithubToken() (string, error) {
	if os.Getenv("EGET_GITHUB_TOKEN") != "" {
		return tokenFrom(os.Getenv("EGET_GITHUB_TOKEN"))
	}
	if os.Getenv("GITHUB_TOKEN") != "" {
		return tokenFrom(os.Getenv("GITHUB_TOKEN"))
	}
	return "", ErrNoToken
}

// SetAuthHeader is a no-op on wasm.
func SetAuthHeader(req *http.Request) *http.Request {
	return req
}

func urlToPath(url string) string {
	p := strings.Replace(url, "://", "/", 1)
	return path.Join("/tmp", p)
}

func Get(url string) (*http.Response, error) {
	p := urlToPath(url)
	f, err := os.Open(p)
	if err != nil {
		return nil, fmt.Errorf("wasm Get: failed to open %s for url %s: %w", p, url, err)
	}

	fi, err := f.Stat()
	if err != nil {
		f.Close()
		return nil, err
	}

	return &http.Response{
		StatusCode:    http.StatusOK,
		Body:          f,
		ContentLength: fi.Size(),
		Header:        make(http.Header),
	}, nil
}

type RateLimitJson struct {
	Resources map[string]RateLimit
}

type RateLimit struct {
	Limit     int
	Remaining int
	Reset     int64
}

func (r RateLimit) ResetTime() time.Time {
	return time.Unix(r.Reset, 0)
}

func (r RateLimit) String() string {
	now := time.Now()
	rtime := r.ResetTime()
	if rtime.Before(now) {
		return fmt.Sprintf("Limit: %d, Remaining: %d, Reset: %v", r.Limit, r.Remaining, rtime)
	} else {
		return fmt.Sprintf(
			"Limit: %d, Remaining: %d, Reset: %v (%v)",
			r.Limit, r.Remaining, rtime, rtime.Sub(now).Round(time.Second),
		)
	}
}

func GetRateLimit() (RateLimit, error) {
	url := "https://api.github.com/rate_limit"
	p := urlToPath(url)
	b, err := os.ReadFile(p)
	if err != nil {
		return RateLimit{}, err
	}

	var parsed RateLimitJson
	err = json.Unmarshal(b, &parsed)

	return parsed.Resources["core"], err
}

// Download the file at 'url' and write the http response body to 'out'. The
// 'getbar' function allows the caller to construct a progress bar given the
// size of the file being downloaded, and the download will write to the
// returned progress bar.
func Download(url string, out io.Writer, getbar func(size int64) *pb.ProgressBar) error {
	if IsLocalFile(url) {
		f, err := os.Open(url)
		if err != nil {
			return err
		}
		defer f.Close()
		_, err = io.Copy(out, f)
		return err
	}

	resp, err := Get(url)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, err := io.ReadAll(resp.Body)
		if err != nil {
			return err
		}
		return fmt.Errorf("download error: %d: %s", resp.StatusCode, body)
	}

	bar := getbar(resp.ContentLength)
	_, err = io.Copy(io.MultiWriter(out, bar), resp.Body)
	return err
}
