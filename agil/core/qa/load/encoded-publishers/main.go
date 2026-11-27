package main

import (
	"context"
	"flag"
	"fmt"
	"log"
	"os"
	"os/signal"
	"sync"
	"time"

	"github.com/livekit/protocol/livekit"
	lk "github.com/livekit/server-sdk-go/v2"
)

func main() {
	url := flag.String("url", "", "LiveKit WebSocket URL")
	room := flag.String("room", "", "LiveKit room")
	file := flag.String("file", "", "pre-encoded VP8 IVF file")
	audioFile := flag.String("audio", "", "optional pre-encoded Opus Ogg file")
	count := flag.Int("count", 1, "number of camera publishers")
	width := flag.Int("width", 320, "encoded video width")
	height := flag.Int("height", 180, "encoded video height")
	fps := flag.Int("fps", 15, "encoded frame rate")
	flag.Parse()
	if *count < 1 || *width < 1 || *height < 1 || *fps < 1 || *url == "" || *room == "" || *file == "" {
		log.Fatal("expected url, room, file and positive media parameters")
	}
	apiKey, apiSecret := os.Getenv("LIVEKIT_API_KEY"), os.Getenv("LIVEKIT_API_SECRET")
	if apiKey == "" || apiSecret == "" {
		log.Fatal("set LIVEKIT_API_KEY and LIVEKIT_API_SECRET")
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	defer stop()
	var publishers sync.WaitGroup
	for i := 1; i <= *count; i++ {
		if ctx.Err() != nil {
			break
		}
		identity := fmt.Sprintf("guest-%03d", i)
		publishers.Add(1)
		go func() {
			defer publishers.Done()
			session, err := lk.ConnectToRoom(*url, lk.ConnectInfo{
				APIKey: apiKey, APISecret: apiSecret, RoomName: *room,
				ParticipantIdentity: identity, ParticipantName: identity,
			}, lk.NewRoomCallback(), lk.WithAutoSubscribe(false), lk.WithConnectTimeout(20*time.Second), lk.WithDisableTURN())
			if err != nil {
				log.Printf("%s connect: %v", identity, err)
				return
			}
			defer session.Disconnect()
			track, err := lk.NewLocalFileTrack(*file, lk.ReaderTrackWithFrameDuration(time.Second/time.Duration(*fps)))
			if err != nil {
				log.Printf("%s open: %v", identity, err)
				return
			}
			defer track.Close()
			_, err = session.LocalParticipant.PublishTrack(track, &lk.TrackPublicationOptions{
				Name: "camera", Source: livekit.TrackSource_CAMERA, VideoWidth: *width, VideoHeight: *height,
			})
			if err != nil {
				log.Printf("%s publish: %v", identity, err)
				return
			}
			fmt.Printf("PUBLISHED %s\n", identity)
			if *audioFile != "" {
				audio, err := lk.NewLocalFileTrack(*audioFile)
				if err != nil {
					log.Printf("%s audio open: %v", identity, err)
					return
				}
				defer audio.Close()
				_, err = session.LocalParticipant.PublishTrack(audio, &lk.TrackPublicationOptions{
					Name: "microphone", Source: livekit.TrackSource_MICROPHONE,
				})
				if err != nil {
					log.Printf("%s audio publish: %v", identity, err)
					return
				}
				fmt.Printf("AUDIO %s\n", identity)
			}
			<-ctx.Done()
		}()
		time.Sleep(85 * time.Millisecond)
	}
	publishers.Wait()
}
